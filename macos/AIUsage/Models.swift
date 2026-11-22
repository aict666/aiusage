import Darwin
import Foundation

enum MemoryTrim {
    /// Returns unused libmalloc magazine pages back to macOS without touching live allocations.
    static func reclaim() {
        _ = malloc_zone_pressure_relief(nil, 0)
    }
}

/// Decodes timestamps represented as ISO-8601 strings, Unix seconds, or Unix milliseconds
/// (matching lib/time.js `parseTime` behavior for Codex epoch numbers and Claude/Grok/agy ISO strings).
struct FlexibleTimestamp: Decodable {
    let date: Date?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self.date = nil
            return
        }
        if let number = try? container.decode(Double.self) {
            if number.isFinite && number > 0 {
                let seconds = number > 10_000_000_000 ? (number / 1000.0) : number
                self.date = Date(timeIntervalSince1970: seconds)
            } else {
                self.date = nil
            }
            return
        }
        if let raw = try? container.decode(String.self) {
            self.date = Formatters.parseTimestampString(raw)
            return
        }
        self.date = nil
    }
}

/// Decodes integer token counts whether serialized as integer or floating-point JSON numbers.
struct SafeInt64: Decodable {
    let value: Int64

    init(_ value: Int64 = 0) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let i = try? container.decode(Int64.self) {
            self.value = i
        } else if let d = try? container.decode(Double.self), d.isFinite {
            self.value = Int64(d.rounded())
        } else {
            self.value = 0
        }
    }
}

struct AIUsagePayload: Decodable {
    let generatedAt: FlexibleTimestamp?
    let providers: [ProviderDto]
    let pricing: PricingDto?
    let costTotals: CostTotalsDto?

    enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case providers
        case pricing
        case costTotals = "cost_totals"
    }
}

struct PricingDto: Decodable {
    let currency: String?
    let checkedAt: String?

    enum CodingKeys: String, CodingKey {
        case currency
        case checkedAt = "checked_at"
    }
}

struct CostTotalsDto: Decodable {
    let today: CostBucketDto?
    let days7: CostBucketDto?
    let days30: CostBucketDto?
}

struct CostBucketDto: Decodable {
    let costUsd: Double
    let pricedTokens: Int64
    let unpricedTokens: Int64
    let incomplete: Bool

    enum CodingKeys: String, CodingKey {
        case costUsd = "cost_usd"
        case pricedTokens = "priced_tokens"
        case unpricedTokens = "unpriced_tokens"
        case incomplete
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.costUsd = (try? c.decode(Double.self, forKey: .costUsd)) ?? 0
        self.pricedTokens = (try? c.decode(SafeInt64.self, forKey: .pricedTokens))?.value ?? 0
        self.unpricedTokens = (try? c.decode(SafeInt64.self, forKey: .unpricedTokens))?.value ?? 0
        self.incomplete = (try? c.decode(Bool.self, forKey: .incomplete)) ?? false
    }
}

struct ProviderAccountDto: Decodable {
    let id: String
    let alias: String
    let email: String?
}

struct AgyCachedWindowDto: Decodable, Equatable {
    let label: String
    let usedPercent: Double?
    let remainingPercent: Double?
    let resetsAtDate: Date?
    let resetPassed: Bool

    enum CodingKeys: String, CodingKey {
        case label
        case usedPercent = "used_percent"
        case remainingPercent = "remaining_percent"
        case resetsAt = "resets_at"
        case resetPassed = "reset_passed"
    }

    init(
        label: String,
        usedPercent: Double?,
        remainingPercent: Double?,
        resetsAtDate: Date? = nil,
        resetPassed: Bool = false
    ) {
        self.label = label
        self.usedPercent = usedPercent
        self.remainingPercent = remainingPercent
        self.resetsAtDate = resetsAtDate
        self.resetPassed = resetPassed
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.label = (try? c.decode(String.self, forKey: .label)) ?? "额度"
        self.usedPercent = try? c.decodeIfPresent(Double.self, forKey: .usedPercent)
        self.remainingPercent = try? c.decodeIfPresent(Double.self, forKey: .remainingPercent)
        let rawReset = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .resetsAt))?.date
        self.resetsAtDate = rawReset.flatMap { $0.timeIntervalSince1970 > 0 ? $0 : nil }
        self.resetPassed = self.resetsAtDate == nil ? false : ((try? c.decode(Bool.self, forKey: .resetPassed)) ?? false)
    }

    var isResetNow: Bool {
        if resetPassed { return true }
        if let d = resetsAtDate { return d <= Date() }
        return false
    }
}

struct AgyCachedQuotaDto: Decodable, Equatable {
    let updatedAtDate: Date?
    let windows: [AgyCachedWindowDto]

    enum CodingKeys: String, CodingKey {
        case updatedAt = "updated_at"
        case windows
    }

    init(updatedAtDate: Date?, windows: [AgyCachedWindowDto]) {
        self.updatedAtDate = updatedAtDate
        self.windows = windows
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.updatedAtDate = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .updatedAt))?.date
        self.windows = (try? c.decode([AgyCachedWindowDto].self, forKey: .windows)) ?? []
    }
}

struct AgyAccountDto: Decodable, Equatable {
    let id: String
    let alias: String
    let email: String?
    let active: Bool
    let savedAt: Date?
    let updatedAt: Date?
    let lastUsedAt: Date?
    let quota: AgyCachedQuotaDto?

    enum CodingKeys: String, CodingKey {
        case id, alias, email, active, quota
        case savedAt = "saved_at"
        case updatedAt = "updated_at"
        case lastUsedAt = "last_used_at"
    }

    init(
        id: String,
        alias: String,
        email: String?,
        active: Bool,
        savedAt: Date? = nil,
        updatedAt: Date? = nil,
        lastUsedAt: Date? = nil,
        quota: AgyCachedQuotaDto? = nil
    ) {
        self.id = id
        self.alias = alias
        self.email = email
        self.active = active
        self.savedAt = savedAt
        self.updatedAt = updatedAt
        self.lastUsedAt = lastUsedAt
        self.quota = quota
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = (try? c.decode(String.self, forKey: .id)) ?? ""
        self.alias = (try? c.decode(String.self, forKey: .alias)) ?? "未命名"
        self.email = try? c.decodeIfPresent(String.self, forKey: .email)
        self.active = (try? c.decode(Bool.self, forKey: .active)) ?? false
        self.savedAt = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .savedAt))?.date
        self.updatedAt = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .updatedAt))?.date
        self.lastUsedAt = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .lastUsedAt))?.date
        self.quota = try? c.decodeIfPresent(AgyCachedQuotaDto.self, forKey: .quota)
    }
}

struct AgyAccountsPayload: Decodable {
    let ok: Bool
    let supported: Bool
    let loggedIn: Bool?
    let liveStatus: String
    let liveEmail: String?
    let keychainChanged: Bool
    let reconciledFrom: String?
    let guarded: Bool
    let guardedOverwriter: String?
    let autoGuard: Bool
    let pinnedId: String?
    let runningAgyCount: Int
    let staleAgyCount: Int
    let activeId: String?
    let previousId: String?
    let accounts: [AgyAccountDto]
    let error: String?

    enum CodingKeys: String, CodingKey {
        case ok, supported, guarded, accounts, error
        case loggedIn = "logged_in"
        case liveStatus = "live_status"
        case liveEmail = "live_email"
        case keychainChanged = "keychain_changed"
        case reconciledFrom = "reconciled_from"
        case guardedOverwriter = "guarded_overwriter"
        case autoGuard = "auto_guard"
        case pinnedId = "pinned_id"
        case runningAgyCount = "running_agy_count"
        case staleAgyCount = "stale_agy_count"
        case activeId = "active_id"
        case previousId = "previous_id"
    }

    init(
        ok: Bool = true,
        supported: Bool = true,
        loggedIn: Bool? = true,
        liveStatus: String = "matched",
        liveEmail: String? = nil,
        keychainChanged: Bool = false,
        reconciledFrom: String? = nil,
        guarded: Bool = false,
        guardedOverwriter: String? = nil,
        autoGuard: Bool = true,
        pinnedId: String? = nil,
        runningAgyCount: Int = 0,
        staleAgyCount: Int = 0,
        activeId: String? = nil,
        previousId: String? = nil,
        accounts: [AgyAccountDto] = [],
        error: String? = nil
    ) {
        self.ok = ok
        self.supported = supported
        self.loggedIn = loggedIn
        self.liveStatus = liveStatus
        self.liveEmail = liveEmail
        self.keychainChanged = keychainChanged
        self.reconciledFrom = reconciledFrom
        self.guarded = guarded
        self.guardedOverwriter = guardedOverwriter
        self.autoGuard = autoGuard
        self.pinnedId = pinnedId
        self.runningAgyCount = runningAgyCount
        self.staleAgyCount = staleAgyCount
        self.activeId = activeId
        self.previousId = previousId
        self.accounts = accounts
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.ok = (try? c.decode(Bool.self, forKey: .ok)) ?? true
        self.supported = (try? c.decode(Bool.self, forKey: .supported)) ?? true
        self.loggedIn = try? c.decodeIfPresent(Bool.self, forKey: .loggedIn)
        self.liveStatus = (try? c.decode(String.self, forKey: .liveStatus)) ?? "unknown"
        self.liveEmail = try? c.decodeIfPresent(String.self, forKey: .liveEmail)
        self.keychainChanged = (try? c.decode(Bool.self, forKey: .keychainChanged)) ?? false
        self.reconciledFrom = try? c.decodeIfPresent(String.self, forKey: .reconciledFrom)
        self.guarded = (try? c.decode(Bool.self, forKey: .guarded)) ?? false
        self.guardedOverwriter = try? c.decodeIfPresent(String.self, forKey: .guardedOverwriter)
        self.autoGuard = (try? c.decode(Bool.self, forKey: .autoGuard)) ?? true
        self.pinnedId = try? c.decodeIfPresent(String.self, forKey: .pinnedId)
        self.runningAgyCount = (try? c.decode(Int.self, forKey: .runningAgyCount)) ?? 0
        self.staleAgyCount = (try? c.decode(Int.self, forKey: .staleAgyCount)) ?? 0
        self.activeId = try? c.decodeIfPresent(String.self, forKey: .activeId)
        self.previousId = try? c.decodeIfPresent(String.self, forKey: .previousId)
        self.accounts = (try? c.decode([AgyAccountDto].self, forKey: .accounts)) ?? []
        self.error = try? c.decodeIfPresent(String.self, forKey: .error)
    }

    var activeAccount: AgyAccountDto? {
        accounts.first(where: { $0.active }) ?? accounts.first(where: { $0.id == activeId })
    }
}

struct AgyAccountMutationResponse: Decodable {
    let ok: Bool
    let action: String?
    let account: AgyAccountDto?
    let removed: AgyAccountDto?
    let previousAlias: String?
    let syncedCurrent: String?
    let syncedAccount: String?
    let stoppedAgyCount: Int?
    let stoppedCount: Int?
    let skippedCurrentCount: Int?
    let runningAgyCount: Int?
    let staleAgyCount: Int?
    let autoGuard: Bool?
    let accounts: [AgyAccountDto]?
    let error: String?
    let code: String?

    enum CodingKeys: String, CodingKey {
        case ok, action, account, removed, accounts, error, code
        case previousAlias = "previous_alias"
        case syncedCurrent = "synced_current"
        case syncedAccount = "synced_account"
        case stoppedAgyCount = "stopped_agy_count"
        case stoppedCount = "stopped_count"
        case skippedCurrentCount = "skipped_current_count"
        case runningAgyCount = "running_agy_count"
        case staleAgyCount = "stale_agy_count"
        case autoGuard = "auto_guard"
    }
}

struct AgyGuardResponse: Decodable {
    let ok: Bool
    let guarded: Bool
    let guardedOverwriter: String?
    let reconciledFrom: String?
    let activeId: String?
    let activeAlias: String?
    let autoGuard: Bool?
    let runningAgyCount: Int?
    let staleAgyCount: Int?

    enum CodingKeys: String, CodingKey {
        case ok, guarded
        case guardedOverwriter = "guarded_overwriter"
        case reconciledFrom = "reconciled_from"
        case activeId = "active_id"
        case activeAlias = "active_alias"
        case autoGuard = "auto_guard"
        case runningAgyCount = "running_agy_count"
        case staleAgyCount = "stale_agy_count"
    }
}

struct ProviderDto: Decodable {
    let name: String
    let plan: String?
    let account: ProviderAccountDto?
    let resetCredits: ResetCreditsDto?
    let windows: [WindowDto]
    let tokens: TokensDto?
    let tokensSupported: Bool?
    let error: String?
    let skipped: Bool
    let quota: QuotaMetaDto?

    enum CodingKeys: String, CodingKey {
        case name
        case plan
        case account
        case resetCredits = "reset_credits"
        case windows
        case tokens
        case tokensSupported = "tokens_supported"
        case error
        case skipped
        case quota
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = (try? c.decode(String.self, forKey: .name)) ?? "未知"
        self.plan = try? c.decodeIfPresent(String.self, forKey: .plan)
        self.account = try? c.decodeIfPresent(ProviderAccountDto.self, forKey: .account)
        self.resetCredits = try? c.decodeIfPresent(ResetCreditsDto.self, forKey: .resetCredits)
        self.windows = (try? c.decode([WindowDto].self, forKey: .windows)) ?? []
        self.tokens = try? c.decodeIfPresent(TokensDto.self, forKey: .tokens)
        self.tokensSupported = try? c.decodeIfPresent(Bool.self, forKey: .tokensSupported)
        self.error = try? c.decodeIfPresent(String.self, forKey: .error)
        self.skipped = (try? c.decode(Bool.self, forKey: .skipped)) ?? false
        self.quota = try? c.decodeIfPresent(QuotaMetaDto.self, forKey: .quota)
    }

    var supportsTokens: Bool {
        tokensSupported ?? true
    }
}

struct WindowDto: Decodable {
    let label: String
    let usedPercent: Double?
    let resetsAtDate: Date?
    let pace: PaceDto?

    enum CodingKeys: String, CodingKey {
        case label
        case usedPercent = "used_percent"
        case resetsAt = "resets_at"
        case pace
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.label = (try? c.decode(String.self, forKey: .label)) ?? "额度"
        self.usedPercent = try? c.decodeIfPresent(Double.self, forKey: .usedPercent)
        let rawReset = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .resetsAt))?.date
        self.resetsAtDate = rawReset.flatMap { $0.timeIntervalSince1970 > 0 ? $0 : nil }
        self.pace = try? c.decodeIfPresent(PaceDto.self, forKey: .pace)
    }

    var remainingPercent: Double? {
        guard let used = usedPercent, used.isFinite else { return nil }
        return max(0, min(100, 100 - used))
    }
}

struct PaceDto: Decodable {
    let windowSeconds: Int
    let elapsedPercent: Double
    let deltaPercent: Double
    let ratio: Double?
    let exhaustsAtDate: Date?
    let status: String

    enum CodingKeys: String, CodingKey {
        case windowSeconds = "window_seconds"
        case elapsedPercent = "elapsed_percent"
        case deltaPercent = "delta_percent"
        case ratio
        case exhaustsAt = "exhausts_at"
        case status
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.windowSeconds = (try? c.decode(Int.self, forKey: .windowSeconds)) ?? 0
        self.elapsedPercent = (try? c.decode(Double.self, forKey: .elapsedPercent)) ?? 0
        self.deltaPercent = (try? c.decode(Double.self, forKey: .deltaPercent)) ?? 0
        self.ratio = try? c.decodeIfPresent(Double.self, forKey: .ratio)
        self.exhaustsAtDate = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .exhaustsAt))?.date
        self.status = (try? c.decode(String.self, forKey: .status)) ?? "on_track"
    }
}

struct ResetCreditsDto: Decodable {
    let count: Int?
    let applicableCount: Int?
    let credits: [ResetBatchDto]?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case count
        case applicableCount = "applicable_count"
        case credits
        case error
    }
}

struct ResetBatchDto: Decodable {
    let count: Int
    let expiresAtDate: Date?
    let label: String?

    enum CodingKeys: String, CodingKey {
        case count
        case expiresAt = "expires_at"
        case label
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.count = (try? c.decode(Int.self, forKey: .count)) ?? 1
        self.expiresAtDate = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .expiresAt))?.date
        self.label = try? c.decodeIfPresent(String.self, forKey: .label)
    }
}

struct TokensDto: Decodable {
    let today: Int64
    let days7: Int64
    let days30: Int64
    let models: [ModelTokensDto]
    let usage: UsagePeriodsDto?

    enum CodingKeys: String, CodingKey {
        case today, days7, days30, models, usage
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.today = (try? c.decode(SafeInt64.self, forKey: .today))?.value ?? 0
        self.days7 = (try? c.decode(SafeInt64.self, forKey: .days7))?.value ?? 0
        self.days30 = (try? c.decode(SafeInt64.self, forKey: .days30))?.value ?? 0
        self.models = (try? c.decode([ModelTokensDto].self, forKey: .models)) ?? []
        self.usage = try? c.decodeIfPresent(UsagePeriodsDto.self, forKey: .usage)
    }
}

struct ModelTokensDto: Decodable {
    let model: String
    let today: Int64
    let days7: Int64
    let days30: Int64
    let usage: UsagePeriodsDto?

    enum CodingKeys: String, CodingKey {
        case model, today, days7, days30, usage
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.model = (try? c.decode(String.self, forKey: .model)) ?? "未知"
        self.today = (try? c.decode(SafeInt64.self, forKey: .today))?.value ?? 0
        self.days7 = (try? c.decode(SafeInt64.self, forKey: .days7))?.value ?? 0
        self.days30 = (try? c.decode(SafeInt64.self, forKey: .days30))?.value ?? 0
        self.usage = try? c.decodeIfPresent(UsagePeriodsDto.self, forKey: .usage)
    }
}

struct UsagePeriodsDto: Decodable {
    let today: UsagePeriodDetailDto?
    let days7: UsagePeriodDetailDto?
    let days30: UsagePeriodDetailDto?
}

struct UsagePeriodDetailDto: Decodable {
    let inputTokens: Int64?
    let outputTokens: Int64?
    let cacheReadTokens: Int64?
    let cacheWriteTokens: Int64?
    let unclassifiedTokens: Int64?
    let costUsd: Double?
    let pricedTokens: Int64?
    let unpricedTokens: Int64?
    let missing: [String]?

    enum CodingKeys: String, CodingKey {
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case cacheReadTokens = "cache_read_tokens"
        case cacheWriteTokens = "cache_write_tokens"
        case unclassifiedTokens = "unclassified_tokens"
        case costUsd = "cost_usd"
        case pricedTokens = "priced_tokens"
        case unpricedTokens = "unpriced_tokens"
        case missing
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.inputTokens = (try? c.decodeIfPresent(SafeInt64.self, forKey: .inputTokens))?.value
        self.outputTokens = (try? c.decodeIfPresent(SafeInt64.self, forKey: .outputTokens))?.value
        self.cacheReadTokens = (try? c.decodeIfPresent(SafeInt64.self, forKey: .cacheReadTokens))?.value
        self.cacheWriteTokens = (try? c.decodeIfPresent(SafeInt64.self, forKey: .cacheWriteTokens))?.value
        self.unclassifiedTokens = (try? c.decodeIfPresent(SafeInt64.self, forKey: .unclassifiedTokens))?.value
        self.costUsd = try? c.decodeIfPresent(Double.self, forKey: .costUsd)
        self.pricedTokens = (try? c.decodeIfPresent(SafeInt64.self, forKey: .pricedTokens))?.value
        self.unpricedTokens = (try? c.decodeIfPresent(SafeInt64.self, forKey: .unpricedTokens))?.value
        self.missing = try? c.decodeIfPresent([String].self, forKey: .missing)
    }

    var cacheHitRateText: String? {
        guard let input = inputTokens, let read = cacheReadTokens, let write = cacheWriteTokens else { return nil }
        if (unclassifiedTokens ?? 0) > 0 { return nil }
        let miss = missing ?? []
        if miss.contains("input_tokens") || miss.contains("cache_read_tokens") || miss.contains("cache_write_tokens") {
            return nil
        }
        let prompt = input + read + write
        guard prompt > 0 else { return nil }
        return String(format: "%.1f%%", (Double(read) / Double(prompt)) * 100.0)
    }
}

struct QuotaMetaDto: Decodable {
    let updatedAtDate: Date?
    let nextRefreshAtDate: Date?
    let cached: Bool?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case updatedAt = "updated_at"
        case nextRefreshAt = "next_refresh_at"
        case cached
        case status
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.updatedAtDate = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .updatedAt))?.date
        self.nextRefreshAtDate = (try? c.decodeIfPresent(FlexibleTimestamp.self, forKey: .nextRefreshAt))?.date
        self.cached = try? c.decodeIfPresent(Bool.self, forKey: .cached)
        self.status = try? c.decodeIfPresent(String.self, forKey: .status)
    }
}

enum MenuBarDisplayStyle: String, CaseIterable {
    case urgentRemaining = "urgent"
    case iconOnly = "icon"
    case todayCost = "cost"
    case multiCompact = "multi"

    var title: String {
        switch self {
        case .urgentRemaining: return "最紧迫服务图标 + 剩余%"
        case .iconOnly: return "仅极简图标"
        case .todayCost: return "图标 + 今日 USD"
        case .multiCompact: return "多服务图标 + 剩余%"
        }
    }
}

enum NavigationTab: Equatable {
    case overview
    case provider(String)
    case settings
}

enum Formatters {
    private static let isoFractionalFallback: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlainFallback: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let clockFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    private static let dateClockFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm"
        return f
    }()

    /// Fast zero-ICU RFC3339 / ISO-8601 parser (`YYYY-MM-DDTHH:mm:ss(.sss)?(Z|±HH:MM)`),
    /// avoiding Foundation `ISO8601DateFormatter` heap/ICU initialization during background refreshes.
    private static func parseRFC3339Fast(_ raw: String) -> Date? {
        let bytes = Array(raw.utf8)
        let n = bytes.count
        guard n >= 20 else { return nil }
        guard bytes[4] == 45, bytes[7] == 45,
              (bytes[10] == 84 || bytes[10] == 116 || bytes[10] == 32),
              bytes[13] == 58, bytes[16] == 58 else { return nil }

        func parseDigits(_ start: Int, _ count: Int) -> Int? {
            guard start + count <= n else { return nil }
            var val = 0
            for i in start..<(start + count) {
                let d = Int(bytes[i]) - 48
                guard d >= 0 && d <= 9 else { return nil }
                val = val * 10 + d
            }
            return val
        }

        guard let year = parseDigits(0, 4),
              let month = parseDigits(5, 2), (1...12).contains(month),
              let day = parseDigits(8, 2), (1...31).contains(day),
              let hour = parseDigits(11, 2), (0...23).contains(hour),
              let minute = parseDigits(14, 2), (0...59).contains(minute),
              let second = parseDigits(17, 2), (0...60).contains(second) else {
            return nil
        }

        var idx = 19
        var fractional = 0.0
        if idx < n && bytes[idx] == 46 { // '.'
            idx += 1
            var scale = 0.1
            var sawDigit = false
            while idx < n {
                let d = Int(bytes[idx]) - 48
                if d >= 0 && d <= 9 {
                    sawDigit = true
                    fractional += Double(d) * scale
                    scale *= 0.1
                    idx += 1
                } else {
                    break
                }
            }
            guard sawDigit else { return nil }
        }

        var tzOffsetSeconds = 0
        if idx < n && (bytes[idx] == 90 || bytes[idx] == 122) { // 'Z' or 'z'
            idx += 1
        } else if idx < n && (bytes[idx] == 43 || bytes[idx] == 45) { // '+' or '-'
            let sign = (bytes[idx] == 43) ? 1 : -1
            idx += 1
            guard let tzH = parseDigits(idx, 2) else { return nil }
            idx += 2
            if idx < n && bytes[idx] == 58 { idx += 1 }
            let tzM: Int
            if idx + 2 <= n, let m = parseDigits(idx, 2) {
                tzM = m
                idx += 2
            } else {
                tzM = 0
            }
            tzOffsetSeconds = sign * (tzH * 3600 + tzM * 60)
        } else {
            return nil
        }

        guard idx == n else { return nil }

        var t = tm()
        t.tm_year = Int32(year - 1900)
        t.tm_mon = Int32(month - 1)
        t.tm_mday = Int32(day)
        t.tm_hour = Int32(hour)
        t.tm_min = Int32(minute)
        t.tm_sec = Int32(second)
        let epoch = timegm(&t)
        if epoch == -1 && year != 1969 { return nil }
        return Date(timeIntervalSince1970: Double(epoch - tzOffsetSeconds) + fractional)
    }

    static func parseTimestampString(_ raw: String?) -> Date? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        if let fast = parseRFC3339Fast(raw) {
            return fast
        }
        if let num = Double(raw), num.isFinite, num > 0 {
            let seconds = num > 10_000_000_000 ? (num / 1000.0) : num
            return Date(timeIntervalSince1970: seconds)
        }
        return isoFractionalFallback.date(from: raw) ?? isoPlainFallback.date(from: raw)
    }

    static func formatTokens(_ value: Int64?) -> String {
        guard let value = value else { return "—" }
        let absVal = Double(abs(value))
        let sign = value < 0 ? "-" : ""
        let units = ["", "K", "M", "B"]
        var amount = absVal
        var idx = 0
        while idx < units.count - 1 && compactDouble(amount) >= 1000.0 {
            amount /= 1000.0
            idx += 1
        }
        return "\(sign)\(compactString(amount))\(units[idx])"
    }

    private static func compactDouble(_ n: Double) -> Double {
        Double(compactString(n)) ?? n
    }

    private static func compactString(_ n: Double) -> String {
        let fmt: String
        if n >= 100 { fmt = String(format: "%.0f", n) }
        else if n >= 10 { fmt = String(format: "%.1f", n) }
        else { fmt = String(format: "%.2f", n) }
        if !fmt.contains(".") { return fmt }
        var trimmed = fmt
        while trimmed.hasSuffix("0") { trimmed.removeLast() }
        if trimmed.hasSuffix(".") { trimmed.removeLast() }
        return trimmed
    }

    /// Formats USD with 2 decimal places and thousands commas in pure Swift (zero ICU `NumberFormatter` heap overhead).
    private static func formatGroupedTwoDecimals(_ value: Double) -> String {
        let sign = value < 0 ? "-" : ""
        let fixed = String(format: "%.2f", abs(value))
        let parts = fixed.split(separator: ".", maxSplits: 1)
        let intChars = Array(parts[0])
        let fracPart = parts.count > 1 ? parts[1] : Substring("00")
        if intChars.count <= 3 {
            return "\(sign)\(parts[0]).\(fracPart)"
        }
        var grouped = String()
        grouped.reserveCapacity(intChars.count + (intChars.count - 1) / 3 + 4)
        grouped.append(sign)
        for (i, ch) in intChars.enumerated() {
            let remaining = intChars.count - i
            if i > 0 && remaining % 3 == 0 {
                grouped.append(",")
            }
            grouped.append(ch)
        }
        grouped.append(".")
        grouped.append(contentsOf: fracPart)
        return grouped
    }

    static func formatUSD(_ cost: Double?, pricedTokens: Int64? = nil, unpricedTokens: Int64? = nil, incomplete: Bool = false) -> String {
        guard let cost = cost, cost.isFinite else { return "—" }
        let partial = incomplete || ((unpricedTokens ?? 0) > 0)
        if partial && (pricedTokens ?? 0) == 0 && cost == 0 { return "—" }
        if cost > 0 && cost < 0.01 && !partial { return "<$0.01" }
        let formatted = formatGroupedTwoDecimals(cost)
        return "$\(formatted)\(partial ? "+" : "")"
    }

    static func shortModel(_ raw: String) -> String {
        if raw.isEmpty || raw == "未知" { return "未知" }
        let lower = raw.lowercased()
        for family in ["opus", "sonnet", "haiku", "fable", "mythos"] {
            if lower.hasPrefix("claude-\(family)") {
                let cap = family.prefix(1).uppercased() + family.dropFirst()
                let rest = raw.dropFirst("claude-\(family)".count)
                    .replacingOccurrences(of: #"-\d{8}$"#, with: "", options: .regularExpression)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
                    .replacingOccurrences(of: "-", with: ".")
                return rest.isEmpty ? cap : "\(cap) \(rest)"
            }
        }
        if lower.hasPrefix("gpt-") {
            let parts = raw.dropFirst(4).split(separator: "-", maxSplits: 1)
            if parts.count == 2 {
                let suffix = parts[1].prefix(1).uppercased() + parts[1].dropFirst()
                return "GPT-\(parts[0]) \(suffix)"
            }
            return "GPT-\(raw.dropFirst(4))"
        }
        if lower.hasPrefix("grok-") {
            return "Grok \(raw.dropFirst(5))"
        }
        if lower.hasPrefix("gemini-") {
            let parts = raw.dropFirst(7).split(separator: "-").map { part -> String in
                guard let first = part.first else { return "" }
                if first.isNumber { return String(part) }
                return first.uppercased() + part.dropFirst()
            }
            return "Gemini " + parts.joined(separator: " ")
        }
        return raw
    }

    static func formatRelativeCountdown(to target: Date, now: Date = Date()) -> String {
        let delta = target.timeIntervalSince(now)
        if delta <= 0 { return "已到点" }
        let totalMinutes = max(1, Int((delta / 60.0).rounded()))
        if totalMinutes < 60 {
            return "\(totalMinutes)m 后"
        }
        let hours = Int(delta / 3600.0)
        let mins = Int((delta.truncatingRemainder(dividingBy: 3600.0)) / 60.0)
        if hours < 24 {
            return mins > 0 ? "\(hours)h \(mins)m 后" : "\(hours)h 后"
        }
        let days = hours / 24
        let remHours = hours % 24
        return remHours > 0 ? "\(days)d \(remHours)h 后" : "\(days)d 后"
    }

    static func formatWhen(_ target: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        if cal.isDate(target, inSameDayAs: now) {
            return "今天 \(clockFormatter.string(from: target))"
        }
        if let tomorrow = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)),
           cal.isDate(target, inSameDayAs: tomorrow) {
            return "明天 \(clockFormatter.string(from: target))"
        }
        return dateClockFormatter.string(from: target)
    }

    static func providerShortCode(_ name: String) -> String {
        switch name {
        case "Claude": return "C"
        case "Codex": return "X"
        case "Grok": return "G"
        case "agy": return "A"
        default: return String(name.prefix(1)).uppercased()
        }
    }
}
