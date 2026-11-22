import AppKit
import Foundation

@MainActor
final class UsageStore {
    static let allProviders = ["Claude", "Codex", "Grok", "agy"]
    private static let launchAgentLabel = "com.aiusage.app"
    private static let legacyLaunchAgentLabel = "com.aiusage.aiquota"

    private let defaults = UserDefaults.standard

    init() {
        migrateLegacyPreferencesIfNeeded()
    }

    private func migrateLegacyPreferencesIfNeeded() {
        guard !defaults.bool(forKey: "migrated_from_aiquota_v1") else { return }
        if let legacy = UserDefaults(suiteName: Self.legacyLaunchAgentLabel) {
            if defaults.object(forKey: "menuBarStyle") == nil, let style = legacy.string(forKey: "menuBarStyle") {
                defaults.set(style, forKey: "menuBarStyle")
            }
            if defaults.object(forKey: "refreshIntervalSeconds") == nil {
                let sec = legacy.integer(forKey: "refreshIntervalSeconds")
                if sec > 0 { defaults.set(sec, forKey: "refreshIntervalSeconds") }
            }
            for name in Self.allProviders {
                let key = "provider_enabled_\(name)"
                if defaults.object(forKey: key) == nil, legacy.object(forKey: key) != nil {
                    defaults.set(legacy.bool(forKey: key), forKey: key)
                }
            }
        }
        let legacyPlist = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(Self.legacyLaunchAgentLabel).plist")
        if FileManager.default.fileExists(atPath: legacyPlist.path) {
            try? FileManager.default.removeItem(at: legacyPlist)
            setLaunchAtLogin(true)
        }
        defaults.set(true, forKey: "migrated_from_aiquota_v1")
    }
    var onChange: (() -> Void)?
    var isPanelVisible: (() -> Bool)?

    struct AgyNotice {
        let text: String
        let isError: Bool
    }

    enum AgyConflict: Equatable {
        case unsavedSwitch(targetId: String, targetAlias: String)
        case unsavedLogout
    }

    private nonisolated static let cliQueue = DispatchQueue(label: "com.aiusage.cli", qos: .utility)
    private nonisolated static let pipeDrainQueue = DispatchQueue(label: "com.aiusage.pipe", qos: .utility)

    private(set) var payload: AIUsagePayload?
    private(set) var isRefreshing = false
    private(set) var lastUpdatedAt: Date?
    private(set) var lastError: String?
    private(set) var engineDescription: String = "未定位"
    private(set) var agyAccounts: AgyAccountsPayload?
    private(set) var isAgyAccountBusy = false
    private(set) var agyNotice: AgyNotice?
    private(set) var agyConflict: AgyConflict?

    private var refreshTimer: Timer?
    private var pendingRefresh: (offlineOnly: Bool, forceRemote: Bool)?
    private var isRefreshingAgyAccounts = false
    private var keychainWatchSource: DispatchSourceFileSystemObject?
    private var keychainDbWatchSource: DispatchSourceFileSystemObject?
    private var keychainDebounceWork: DispatchWorkItem?
    private var isGuardingKeychain = false
    private var pendingKeychainGuard = false
    private var lastKeychainGuardAt: Date = .distantPast

    var closeRunningAgyOnSwitch: Bool {
        get { defaults.bool(forKey: "agy_close_running_on_switch") }
        set {
            defaults.set(newValue, forKey: "agy_close_running_on_switch")
            notify()
        }
    }

    var agyAutoGuardEnabled: Bool {
        agyAccounts?.autoGuard ?? true
    }

    var menuBarStyle: MenuBarDisplayStyle {
        get {
            let raw = defaults.string(forKey: "menuBarStyle") ?? MenuBarDisplayStyle.urgentRemaining.rawValue
            return MenuBarDisplayStyle(rawValue: raw) ?? .urgentRemaining
        }
        set {
            defaults.set(newValue.rawValue, forKey: "menuBarStyle")
            notify()
        }
    }

    var refreshIntervalSeconds: Int {
        get {
            let val = defaults.integer(forKey: "refreshIntervalSeconds")
            return [60, 300, 600, 900].contains(val) ? val : 300
        }
        set {
            defaults.set(newValue, forKey: "refreshIntervalSeconds")
            rescheduleTimer()
            notify()
        }
    }

    var isDemoMode: Bool {
        get { defaults.bool(forKey: "isDemoMode") }
        set {
            defaults.set(newValue, forKey: "isDemoMode")
            triggerRefresh(offlineOnly: false)
        }
    }

    var isOfflineMode: Bool {
        get { defaults.bool(forKey: "isOfflineMode") }
        set {
            defaults.set(newValue, forKey: "isOfflineMode")
            triggerRefresh(offlineOnly: true)
        }
    }

    func isProviderEnabled(_ name: String) -> Bool {
        let key = "provider_enabled_\(name)"
        if defaults.object(forKey: key) == nil { return true }
        return defaults.bool(forKey: key)
    }

    func setProviderEnabled(_ name: String, enabled: Bool) {
        // Keep at least one provider enabled so the UI is never empty by accident.
        if !enabled {
            let enabledCount = Self.allProviders.filter { isProviderEnabled($0) }.count
            if enabledCount <= 1 { return }
        }
        defaults.set(enabled, forKey: "provider_enabled_\(name)")
        notify()
    }

    var enabledProviders: [ProviderDto] {
        guard let list = payload?.providers else { return [] }
        return list.filter { isProviderEnabled($0.name) }
    }

    func isProviderLoggedInOrActive(_ name: String) -> Bool {
        if isDemoMode { return true }
        guard let dto = payload?.providers.first(where: { $0.name == name }) else {
            return name == "agy" && !(agyAccounts?.accounts.isEmpty ?? true)
        }
        if !dto.skipped { return true }
        if name == "agy", !(agyAccounts?.accounts.isEmpty ?? true) { return true }
        if dto.supportsTokens, (dto.tokens?.days30 ?? 0) > 0 { return true }
        return false
    }

    func isProviderVisible(_ name: String) -> Bool {
        isProviderEnabled(name) && isProviderLoggedInOrActive(name)
    }

    var visibleProviders: [ProviderDto] {
        guard let list = payload?.providers else { return [] }
        return list.filter { isProviderVisible($0.name) }
    }

    var launchAtLogin: Bool {
        get { FileManager.default.fileExists(atPath: Self.launchAgentURL.path) }
        set {
            setLaunchAtLogin(newValue)
            notify()
        }
    }

    private static var launchAgentURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(launchAgentLabel).plist")
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        let url = Self.launchAgentURL
        let fm = FileManager.default
        if !enabled {
            try? fm.removeItem(at: url)
            return
        }
        guard let executablePath = Bundle.main.executablePath else { return }
        let plist: [String: Any] = [
            "Label": Self.launchAgentLabel,
            "ProgramArguments": [executablePath],
            "RunAtLoad": true,
            "KeepAlive": false,
            "ProcessType": "Interactive",
        ]
        do {
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: url, options: .atomic)
        } catch {
            // Keep UI responsive if LaunchAgents is restricted.
        }
    }

    func start() {
        rescheduleTimer()
        startKeychainGuardWatcher()
        refreshAgyAccounts(verify: false)
        // Instant <25ms startup: load cached quota + incremental local tokens offline first,
        // then run a normal background check if not in offline/demo mode.
        if isDemoMode || isOfflineMode {
            triggerRefresh(offlineOnly: isOfflineMode)
        } else {
            triggerRefresh(offlineOnly: true) { [weak self] in
                guard let self = self, !self.isDemoMode, !self.isOfflineMode else { return }
                self.triggerRefresh(offlineOnly: false)
            }
        }
    }

    func refreshOnPanelOpenIfNeeded() {
        refreshAgyAccounts(verify: false)
        if isRefreshing { return }
        guard let last = lastUpdatedAt else {
            triggerRefresh(offlineOnly: isOfflineMode)
            return
        }
        let quotaDue = nextQuotaRefreshDate.map { $0 <= Date() } ?? false
        if quotaDue && !isOfflineMode && !isDemoMode {
            triggerRefresh(offlineOnly: false)
            return
        }
        let age = Date().timeIntervalSince(last)
        if age >= 30 {
            // Fast offline incremental token refresh when opening panel
            triggerRefresh(offlineOnly: isOfflineMode || !isDemoMode)
        }
    }

    func rescheduleTimer() {
        refreshTimer?.invalidate()
        let interval = TimeInterval(refreshIntervalSeconds)
        let timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                self.triggerRefresh(offlineOnly: self.isOfflineMode)
            }
        }
        // 15% timer tolerance lets macOS coalesce wakeups and engage App Nap cleanly.
        timer.tolerance = interval * 0.15
        refreshTimer = timer
    }

    var nextQuotaRefreshDate: Date? {
        let dates = visibleProviders
            .compactMap { $0.quota?.nextRefreshAtDate }
        return dates.min()
    }

    func quotaUpdatedAt(for tab: NavigationTab) -> Date? {
        if case .provider(let name) = tab {
            return payload?.providers.first(where: { $0.name == name })?.quota?.updatedAtDate
        }
        return visibleProviders.compactMap { $0.quota?.updatedAtDate }.max()
    }

    func nextQuotaRefreshDate(for tab: NavigationTab) -> Date? {
        if case .provider(let name) = tab {
            return payload?.providers.first(where: { $0.name == name })?.quota?.nextRefreshAtDate
        }
        return nextQuotaRefreshDate
    }

    struct UrgentSummary {
        let provider: String
        let windowLabel: String
        let remainingPercent: Double
        let usedPercent: Double
        let isCriticalPace: Bool
    }

    var mostUrgentWindow: UrgentSummary? {
        var best: UrgentSummary?
        for provider in enabledProviders where !provider.skipped {
            for win in provider.windows {
                guard let used = win.usedPercent, let rem = win.remainingPercent else { continue }
                // Skip pure on-demand/extra buckets without a reset window when normal windows exist
                let isCritPace = win.pace?.status == "critical"
                let candidate = UrgentSummary(
                    provider: provider.name,
                    windowLabel: win.label,
                    remainingPercent: rem,
                    usedPercent: used,
                    isCriticalPace: isCritPace
                )
                if let current = best {
                    let candidateScore = used + (isCritPace ? 12 : 0)
                    let currentScore = current.usedPercent + (current.isCriticalPace ? 12 : 0)
                    if candidateScore > currentScore {
                        best = candidate
                    }
                } else {
                    best = candidate
                }
            }
        }
        return best
    }

    var filteredTodayCost: (usd: Double, priced: Int64, unpriced: Int64, incomplete: Bool) {
        let tokenProviders = enabledProviders.filter { $0.supportsTokens }
        var usd = 0.0
        var priced: Int64 = 0
        var unpriced: Int64 = 0
        var incomplete = false
        for p in tokenProviders {
            if let today = p.tokens?.usage?.today {
                usd += today.costUsd ?? 0
                priced += today.pricedTokens ?? 0
                unpriced += today.unpricedTokens ?? 0
                if (today.unpricedTokens ?? 0) > 0 { incomplete = true }
            } else if (p.tokens?.today ?? 0) != 0 {
                incomplete = true
            }
        }
        return (usd, priced, unpriced, incomplete)
    }

    func filteredPeriodCost(_ keyPath: KeyPath<UsagePeriodsDto, UsagePeriodDetailDto?>, rawKeyPath: KeyPath<TokensDto, Int64>) -> (usd: Double, tokens: Int64, priced: Int64, unpriced: Int64, incomplete: Bool) {
        let tokenProviders = enabledProviders.filter { $0.supportsTokens }
        var usd = 0.0
        var totalTokens: Int64 = 0
        var priced: Int64 = 0
        var unpriced: Int64 = 0
        var incomplete = false
        for p in tokenProviders {
            guard let t = p.tokens else { continue }
            totalTokens += t[keyPath: rawKeyPath]
            if let detail = t.usage?[keyPath: keyPath] {
                usd += detail.costUsd ?? 0
                priced += detail.pricedTokens ?? 0
                unpriced += detail.unpricedTokens ?? 0
                if (detail.unpricedTokens ?? 0) > 0 { incomplete = true }
            } else if t[keyPath: rawKeyPath] != 0 {
                incomplete = true
            }
        }
        return (usd, totalTokens, priced, unpriced, incomplete)
    }

    private struct ResolvedEngine {
        let executable: String
        let baseArgs: [String]
        let label: String
    }

    private func resolveEngine() -> ResolvedEngine? {
        let fm = FileManager.default
        let env = ProcessInfo.processInfo.environment

        if let explicit = env["AIUSAGE_BIN"], !explicit.isEmpty, fm.isExecutableFile(atPath: explicit) {
            return ResolvedEngine(executable: explicit, baseArgs: [], label: explicit)
        }

        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("aiusage").path,
           fm.isExecutableFile(atPath: bundled) {
            return ResolvedEngine(executable: bundled, baseArgs: [], label: "内置引擎 (Resources/aiusage)")
        }

        // Check embedded repo script path from Info.plist during local development
        if let repoPath = Bundle.main.object(forInfoDictionaryKey: "AIUsageRepoRoot") as? String {
            let distArm = (repoPath as NSString).appendingPathComponent("dist/aiusage-darwin-arm64")
            let distX64 = (repoPath as NSString).appendingPathComponent("dist/aiusage-darwin-x64")
            for bin in [distArm, distX64] where fm.isExecutableFile(atPath: bin) {
                return ResolvedEngine(executable: bin, baseArgs: [], label: bin)
            }
            let script = (repoPath as NSString).appendingPathComponent("bin/aiusage.js")
            if fm.fileExists(atPath: script), let node = findBinary("node") {
                return ResolvedEngine(executable: node, baseArgs: [script], label: "node \(script)")
            }
        }

        if let globalBin = findBinary("aiusage") {
            return ResolvedEngine(executable: globalBin, baseArgs: [], label: globalBin)
        }
        return nil
    }

    private func findBinary(_ name: String) -> String? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        var dirs = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(home)/.local/bin",
            "\(home)/.bun/bin",
        ]
        if let pathEnv = ProcessInfo.processInfo.environment["PATH"] {
            dirs.append(contentsOf: pathEnv.split(separator: ":").map(String.init))
        }
        for dir in dirs {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if fm.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    private func buildChildEnv() -> [String: String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var childEnv = ProcessInfo.processInfo.environment
        let existingPath = childEnv["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        let extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin"]
            .filter { !existingPath.contains($0) }
        childEnv["PATH"] = (extraPaths + [existingPath]).joined(separator: ":")
        childEnv["NO_COLOR"] = "1"
        return childEnv
    }

    func triggerRefresh(offlineOnly: Bool, forceRemote: Bool = false, completion: (() -> Void)? = nil) {
        if isRefreshing {
            // Queue one follow-up refresh so post-switch or manual refreshes are never silently dropped
            // while an earlier background poll is still finishing.
            if let existing = pendingRefresh {
                pendingRefresh = (
                    offlineOnly: existing.offlineOnly && offlineOnly,
                    forceRemote: existing.forceRemote || forceRemote
                )
            } else {
                pendingRefresh = (offlineOnly: offlineOnly, forceRemote: forceRemote)
            }
            completion?()
            return
        }
        guard let engine = resolveEngine() else {
            lastError = "未找到 aiusage 可执行文件，请运行 npm run build:macos"
            engineDescription = "未找到"
            notify()
            completion?()
            return
        }
        engineDescription = engine.label
        isRefreshing = true
        notify()

        var args = engine.baseArgs + ["--json"]
        if isDemoMode {
            args.append("--demo")
        } else if offlineOnly || isOfflineMode {
            args.append("--offline")
        } else if forceRemote {
            args.append("--refresh")
        }

        let childEnv = buildChildEnv()
        let executable = engine.executable
        Self.cliQueue.async { [weak self] in
            let result = autoreleasepool {
                Self.executeCLI(executable: executable, args: args, env: childEnv)
            }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isRefreshing = false
                switch result {
                case .success(let decoded):
                    let agyAccountId = decoded.providers.first(where: { $0.name == "agy" })?.account?.id
                    let activeAccountChanged = (agyAccountId != nil && agyAccountId != self.agyAccounts?.activeId)
                    self.payload = decoded
                    self.lastUpdatedAt = Date()
                    self.lastError = nil
                    if !self.isDemoMode && ((self.isPanelVisible?() ?? false) || activeAccountChanged) {
                        self.refreshAgyAccounts(verify: false)
                    }
                case .failure(let err):
                    self.lastError = err.localizedDescription
                }
                self.notify()
                completion?()
                if let next = self.pendingRefresh {
                    self.pendingRefresh = nil
                    self.triggerRefresh(offlineOnly: next.offlineOnly, forceRemote: next.forceRemote)
                } else if !(self.isPanelVisible?() ?? false) {
                    MemoryTrim.reclaim()
                }
            }
        }
    }

    private func startKeychainGuardWatcher() {
        let keychainsDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Keychains")
        if keychainWatchSource == nil {
            let fd = open(keychainsDir.path, O_EVTONLY)
            if fd >= 0 {
                let source = DispatchSource.makeFileSystemObjectSource(
                    fileDescriptor: fd,
                    eventMask: [.write, .rename, .extend],
                    queue: .main
                )
                source.setEventHandler { [weak self] in
                    self?.scheduleKeychainGuardCheck()
                }
                source.setCancelHandler { [fd] in
                    close(fd)
                }
                source.resume()
                keychainWatchSource = source
            }
        }
        attachKeychainDbWatcher(at: keychainsDir.appendingPathComponent("login.keychain-db").path)
    }

    private func attachKeychainDbWatcher(at path: String) {
        keychainDbWatchSource?.cancel()
        keychainDbWatchSource = nil
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete, .extend, .attrib],
            queue: .main
        )
        source.setEventHandler { [weak self, weak source] in
            guard let self = self else { return }
            let flags = source?.data ?? []
            if flags.contains(.rename) || flags.contains(.delete) {
                // securityd replaced login.keychain-db atomically; re-attach to the new inode.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    self?.attachKeychainDbWatcher(at: path)
                }
            }
            self.scheduleKeychainGuardCheck()
        }
        source.setCancelHandler { [fd] in
            close(fd)
        }
        source.resume()
        keychainDbWatchSource = source
    }

    private func scheduleKeychainGuardCheck() {
        guard !isDemoMode, !isOfflineMode, !isAgyAccountBusy else { return }
        guard let info = agyAccounts, info.supported, info.accounts.count >= 2 else { return }
        if isGuardingKeychain {
            pendingKeychainGuard = true
            return
        }
        keychainDebounceWork?.cancel()
        let elapsed = Date().timeIntervalSince(lastKeychainGuardAt)
        let delay = max(1.5, 2.5 - elapsed)
        let work = DispatchWorkItem { [weak self] in
            self?.runKeychainGuardCheck()
        }
        keychainDebounceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func runKeychainGuardCheck() {
        guard !isDemoMode, !isOfflineMode, !isAgyAccountBusy, !isGuardingKeychain else { return }
        guard let info = agyAccounts, info.supported, info.accounts.count >= 2 else { return }
        guard let engine = resolveEngine() else { return }
        isGuardingKeychain = true
        pendingKeychainGuard = false
        lastKeychainGuardAt = Date()

        let args = engine.baseArgs + ["agy", "guard", "--json"]
        let childEnv = buildChildEnv()
        let executable = engine.executable
        Self.cliQueue.async { [weak self] in
            let raw = autoreleasepool {
                Self.executeRawCLI(executable: executable, args: args, env: childEnv, timeoutSeconds: 10)
            }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isGuardingKeychain = false
                if case .success(let out) = raw, !out.stdout.isEmpty,
                   let resp = try? JSONDecoder().decode(AgyGuardResponse.self, from: out.stdout),
                   resp.ok {
                    if resp.guarded, let activeAlias = resp.activeAlias {
                        let overwriter = resp.guardedOverwriter ?? "旧账号"
                        self.agyNotice = AgyNotice(
                            text: "已自动拦截旧进程覆写：保存了「\(overwriter)」的新票据，并保持当前为「\(activeAlias)」",
                            isError: false
                        )
                        self.refreshAgyAccounts(verify: false)
                    } else if let from = resp.reconciledFrom, !from.isEmpty {
                        self.refreshAgyAccounts(verify: false)
                    }
                }
                if self.pendingKeychainGuard {
                    self.pendingKeychainGuard = false
                    self.scheduleKeychainGuardCheck()
                } else if !(self.isPanelVisible?() ?? false) {
                    MemoryTrim.reclaim()
                }
            }
        }
    }

    // MARK: - Local agy Account Management (Keychain Snapshot + Manual Switch)
    func clearAgyConflict() {
        agyConflict = nil
        notify()
    }

    func clearAgyNotice() {
        agyNotice = nil
        notify()
    }

    func refreshAgyAccounts(verify: Bool = false) {
        guard !isRefreshingAgyAccounts else { return }
        guard let engine = resolveEngine() else { return }
        isRefreshingAgyAccounts = true
        var args = engine.baseArgs + ["agy", "list", "--json"]
        if verify { args.append("--verify") }
        let childEnv = buildChildEnv()
        let executable = engine.executable
        Self.cliQueue.async { [weak self] in
            let decoded: AgyAccountsPayload? = autoreleasepool {
                let raw = Self.executeRawCLI(executable: executable, args: args, env: childEnv, timeoutSeconds: 15)
                guard case .success(let out) = raw, !out.stdout.isEmpty else { return nil }
                return try? JSONDecoder().decode(AgyAccountsPayload.self, from: out.stdout)
            }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isRefreshingAgyAccounts = false
                if let decoded = decoded {
                    let prevActiveId = self.agyAccounts?.activeId
                    self.agyAccounts = decoded
                    if decoded.guarded, let activeAlias = decoded.activeAccount?.alias {
                        let overwriter = decoded.guardedOverwriter ?? "旧账号"
                        self.agyNotice = AgyNotice(
                            text: "已自动拦截旧进程覆写：保存了「\(overwriter)」的新票据，并保持当前为「\(activeAlias)」",
                            isError: false
                        )
                    } else if let from = decoded.reconciledFrom, !from.isEmpty {
                        if let activeAlias = decoded.activeAccount?.alias {
                            self.agyNotice = AgyNotice(
                                text: "检测到钥匙串已变更为「\(activeAlias)」（原为「\(from)」），已自动同步真实当前账号。",
                                isError: true
                            )
                        } else if decoded.liveStatus == "unsaved" {
                            self.agyNotice = AgyNotice(
                                text: "检测到系统钥匙串中的 agy 登录已变动（原为「\(from)」），可点「+ 保存当前」加入列表。",
                                isError: true
                            )
                        }
                        if !self.isDemoMode {
                            self.triggerRefresh(offlineOnly: self.isOfflineMode)
                        }
                    } else if prevActiveId != nil && prevActiveId != decoded.activeId && !self.isDemoMode {
                        self.triggerRefresh(offlineOnly: self.isOfflineMode)
                    }
                    self.notify()
                }
                if !(self.isPanelVisible?() ?? false) {
                    MemoryTrim.reclaim()
                }
            }
        }
    }

    func saveCurrentAgyAccount(alias: String?) {
        var subArgs = ["agy", "save"]
        let trimmed = alias?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { subArgs.append(trimmed) }
        subArgs.append("--json")
        runAgyAccountMutation(subArgs: subArgs, refreshQuotaAfter: true) { [weak self] resp in
            guard let self = self else { return }
            self.agyConflict = nil
            let name = resp.account?.alias ?? (trimmed.isEmpty ? "当前账号" : trimmed)
            let msg = resp.action == "updated" ? "已更新保存的 agy 账号「\(name)」" : "已保存 agy 账号「\(name)」到本机钥匙串"
            self.agyNotice = AgyNotice(text: msg, isError: false)
        }
    }

    func switchAgyAccount(targetId: String, targetAlias: String, force: Bool = false) {
        var subArgs = ["agy", "switch", targetId]
        if force { subArgs.append("--force") }
        if closeRunningAgyOnSwitch { subArgs.append("--close-running") }
        subArgs.append("--json")
        runAgyAccountMutation(subArgs: subArgs, refreshQuotaAfter: true, onFailureCode: { [weak self] code, message in
            guard let self = self else { return }
            if code == "UNSAVED_ACTIVE_ACCOUNT" {
                self.agyConflict = .unsavedSwitch(targetId: targetId, targetAlias: targetAlias)
                self.agyNotice = AgyNotice(text: "当前登录的 agy 账号尚未保存，可先保存再切换，或选择覆盖切换。", isError: true)
            } else {
                self.agyConflict = nil
                self.agyNotice = AgyNotice(text: message, isError: true)
            }
        }) { [weak self] resp in
            guard let self = self else { return }
            self.agyConflict = nil
            let alias = resp.account?.alias ?? targetAlias
            if resp.action == "already_active" {
                self.agyNotice = AgyNotice(text: "当前已是「\(alias)」", isError: false)
            } else {
                let synced = resp.syncedCurrent.map { "（已同步「\($0)」最新票据）" } ?? ""
                let stopped = resp.stoppedAgyCount ?? 0
                let stale = resp.staleAgyCount ?? 0
                let guarded = resp.autoGuard ?? true
                if stopped > 0 {
                    self.agyNotice = AgyNotice(
                        text: "已切到「\(alias)」\(synced) · 已自动关闭 \(stopped) 个旧账号 agy，回到终端运行 agy -c 即可用新号续聊",
                        isError: false
                    )
                } else if stale > 0 && guarded {
                    self.agyNotice = AgyNotice(
                        text: "已切到「\(alias)」\(synced) · 防覆写保护已生效（有 \(stale) 个旧账号 agy 进程；如需清理可点下方「关闭旧 agy」）",
                        isError: false
                    )
                } else if stale > 0 {
                    self.agyNotice = AgyNotice(
                        text: "已切到「\(alias)」\(synced) · 本机有 \(stale) 个旧账号 agy 进程，可点下方「关闭旧 agy」避免写回原号",
                        isError: true
                    )
                } else {
                    self.agyNotice = AgyNotice(text: "已切到「\(alias)」\(synced) · 新开终端运行 agy -c 即可继续会话", isError: false)
                }
            }
        }
    }

    func setAgyAutoGuard(enabled: Bool) {
        runAgyAccountMutation(subArgs: ["agy", "auto-guard", enabled ? "on" : "off", "--json"], refreshQuotaAfter: false) { [weak self] _ in
            self?.agyNotice = AgyNotice(
                text: enabled ? "已开启切号防旧进程覆写保护" : "已关闭切号防覆写保护",
                isError: false
            )
        }
    }

    func stopRunningAgyProcesses() {
        runAgyAccountMutation(subArgs: ["agy", "stop-running", "--json"], refreshQuotaAfter: false) { [weak self] resp in
            let count = resp.stoppedCount ?? 0
            let kept = resp.skippedCurrentCount ?? 0
            let msg: String
            if count > 0 {
                let keptSuffix = kept > 0 ? "（已保留 \(kept) 个当前账号窗口）" : ""
                msg = "已向 \(count) 个旧账号 agy 进程发送温和退出信号\(keptSuffix)，回到终端执行 agy -c 即可用当前账号续聊"
            } else if kept > 0 {
                msg = "当前没有切号前遗留的旧账号 agy 进程（已保护 \(kept) 个当前账号窗口）"
            } else {
                msg = "当前没有需要关闭的旧账号 agy 进程"
            }
            self?.agyNotice = AgyNotice(text: msg, isError: false)
        }
    }

    func prepareNewAgyLogin(force: Bool = false) {
        var subArgs = ["agy", "logout"]
        if force { subArgs.append("--force") }
        subArgs.append("--json")
        runAgyAccountMutation(subArgs: subArgs, refreshQuotaAfter: true, onFailureCode: { [weak self] code, message in
            guard let self = self else { return }
            if code == "UNSAVED_ACTIVE_ACCOUNT" {
                self.agyConflict = .unsavedLogout
                self.agyNotice = AgyNotice(text: "当前登录的 agy 账号尚未保存，建议先保存后再登出。", isError: true)
            } else {
                self.agyConflict = nil
                self.agyNotice = AgyNotice(text: message, isError: true)
            }
        }) { [weak self] resp in
            guard let self = self else { return }
            self.agyConflict = nil
            let synced = resp.syncedAccount.map { "（已保存「\($0)」最新票据）" } ?? ""
            self.agyNotice = AgyNotice(text: "已清空当前登录\(synced) · 请在终端运行 agy 登录新账号，再回来点「+ 保存当前」", isError: false)
        }
    }

    func renameAgyAccount(targetId: String, newAlias: String) {
        let trimmed = newAlias.trimmingCharacters(in: .whitespacesAndNewlines)
        runAgyAccountMutation(subArgs: ["agy", "rename", targetId, trimmed, "--json"], refreshQuotaAfter: false) { [weak self] resp in
            guard let self = self else { return }
            self.agyNotice = AgyNotice(text: "已更新名称为「\(resp.account?.alias ?? trimmed)」", isError: false)
        }
    }

    func removeAgyAccount(targetId: String) {
        runAgyAccountMutation(subArgs: ["agy", "remove", targetId, "--json"], refreshQuotaAfter: false) { [weak self] resp in
            guard let self = self else { return }
            let name = resp.removed?.alias ?? "账号"
            self.agyNotice = AgyNotice(text: "已删除「\(name)」的保存票据（不影响当前登录）", isError: false)
        }
    }

    private func runAgyAccountMutation(
        subArgs: [String],
        refreshQuotaAfter: Bool,
        onFailureCode: ((String?, String) -> Void)? = nil,
        onSuccess: @escaping (AgyAccountMutationResponse) -> Void
    ) {
        if isAgyAccountBusy { return }
        guard let engine = resolveEngine() else {
            agyNotice = AgyNotice(text: "未找到 aiusage 可执行文件", isError: true)
            notify()
            return
        }
        isAgyAccountBusy = true
        notify()

        let args = engine.baseArgs + subArgs
        let childEnv = buildChildEnv()
        let executable = engine.executable
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let raw = Self.executeRawCLI(executable: executable, args: args, env: childEnv, timeoutSeconds: 20)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isAgyAccountBusy = false
                switch raw {
                case .failure(let err):
                    self.agyNotice = AgyNotice(text: err.localizedDescription, isError: true)
                    self.notify()
                case .success(let out):
                    guard !out.stdout.isEmpty,
                          let resp = try? JSONDecoder().decode(AgyAccountMutationResponse.self, from: out.stdout) else {
                        let errText = String(data: out.stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "操作失败"
                        self.agyNotice = AgyNotice(text: errText.isEmpty ? "操作失败" : errText, isError: true)
                        self.notify()
                        return
                    }
                    if resp.ok {
                        onSuccess(resp)
                        self.refreshAgyAccounts(verify: false)
                        self.notify()
                        if refreshQuotaAfter && !self.isDemoMode {
                            self.triggerRefresh(offlineOnly: self.isOfflineMode)
                        }
                    } else {
                        let msg = resp.error ?? "操作失败"
                        if let handler = onFailureCode {
                            handler(resp.code, msg)
                        } else {
                            self.agyNotice = AgyNotice(text: msg, isError: true)
                        }
                        self.notify()
                    }
                }
            }
        }
    }

    private nonisolated static func executeRawCLI(
        executable: String,
        args: [String],
        env: [String: String],
        timeoutSeconds: Int = 55
    ) -> Result<(stdout: Data, stderr: Data, status: Int32), Error> {
        return autoreleasepool {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: executable)
            proc.arguments = args
            proc.environment = env

            let outPipe = Pipe()
            let errPipe = Pipe()
            proc.standardOutput = outPipe
            proc.standardError = errPipe
            proc.standardInput = FileHandle.nullDevice

            defer {
                try? outPipe.fileHandleForReading.close()
                try? errPipe.fileHandleForReading.close()
            }

            do {
                try proc.run()
            } catch {
                try? outPipe.fileHandleForWriting.close()
                try? errPipe.fileHandleForWriting.close()
                return .failure(NSError(domain: "AIUsage", code: 1, userInfo: [NSLocalizedDescriptionKey: "启动采集器失败：\(error.localizedDescription)"]))
            }

            // Close parent-side write ends so reading reaches EOF cleanly when child exits.
            try? outPipe.fileHandleForWriting.close()
            try? errPipe.fileHandleForWriting.close()

            let timeoutWork = DispatchWorkItem { [weak proc] in
                if let p = proc, p.isRunning {
                    p.terminate()
                }
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .seconds(timeoutSeconds), execute: timeoutWork)

            var stderrData = Data()
            let errGroup = DispatchGroup()
            errGroup.enter()
            Self.pipeDrainQueue.async {
                autoreleasepool {
                    stderrData = errPipe.fileHandleForReading.readDataToEndOfFile()
                }
                errGroup.leave()
            }

            let stdoutData = outPipe.fileHandleForReading.readDataToEndOfFile()
            errGroup.wait()
            proc.waitUntilExit()
            let timedOut = timeoutWork.isCancelled ? false : (proc.terminationReason == .uncaughtSignal && proc.terminationStatus == SIGTERM)
            timeoutWork.cancel()

            if timedOut && stdoutData.isEmpty {
                return .failure(NSError(domain: "AIUsage", code: 2, userInfo: [NSLocalizedDescriptionKey: "执行超时（\(timeoutSeconds)s）"]))
            }
            return .success((stdout: stdoutData, stderr: stderrData, status: proc.terminationStatus))
        }
    }

    private nonisolated static func executeCLI(executable: String, args: [String], env: [String: String]) -> Result<AIUsagePayload, Error> {
        switch executeRawCLI(executable: executable, args: args, env: env, timeoutSeconds: 55) {
        case .failure(let err):
            return .failure(err)
        case .success(let out):
            // Note: aiusage exits with 1 if any provider had an error or all are logged out, while still printing valid JSON!
            if !out.stdout.isEmpty {
                do {
                    let decoded = try JSONDecoder().decode(AIUsagePayload.self, from: out.stdout)
                    return .success(decoded)
                } catch {
                    return .failure(NSError(domain: "AIUsage", code: 3, userInfo: [NSLocalizedDescriptionKey: "解析 JSON 失败：\(error.localizedDescription)"]))
                }
            }
            let errText = String(data: out.stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "未知错误"
            return .failure(NSError(domain: "AIUsage", code: Int(out.status), userInfo: [NSLocalizedDescriptionKey: errText.isEmpty ? "采集退出码 \(out.status)" : errText]))
        }
    }

    private func notify() {
        onChange?()
    }

    func injectPayloadForTest(_ testPayload: AIUsagePayload) {
        self.payload = testPayload
        self.lastUpdatedAt = Date()
    }

    func injectAgyAccountsForTest(_ testAccounts: AgyAccountsPayload) {
        self.agyAccounts = testAccounts
    }
}
