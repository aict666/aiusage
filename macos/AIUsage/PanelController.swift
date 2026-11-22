import AppKit

@MainActor
final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    var onEscape: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            onEscape?()
            return
        }
        if event.modifierFlags.contains(.command) {
            if event.charactersIgnoringModifiers == "r" {
                NotificationCenter.default.post(name: .aiUsageManualRefresh, object: nil)
                return
            }
            if event.charactersIgnoringModifiers == "q" {
                NSApp.terminate(nil)
                return
            }
        }
        super.keyDown(with: event)
    }
}

extension Notification.Name {
    static let aiUsageManualRefresh = Notification.Name("aiUsageManualRefresh")
}

@MainActor
final class PanelController: NSObject, NSWindowDelegate {
    private static let panelWidth: CGFloat = 424
    private static let panelHeight: CGFloat = 562
    private static let sidebarWidth: CGFloat = 58
    private static let cornerRadius: CGFloat = 20
    private static let shadowInsets = NSEdgeInsets(top: 6, left: 24, bottom: 26, right: 24)
    /// Delay before fully destroying the closed panel window & Liquid Glass/Metal surfaces.
    private static let idleTeardownDelaySeconds: TimeInterval = 1.5

    /// Holds all AppKit window / Liquid Glass / AutoLayout views for an active panel.
    /// Created lazily on first show and torn down completely when hidden so idle memory stays minimal.
    @MainActor
    private final class PanelSession {
        let panel: FloatingPanel
        let canvasView: GlassCanvasView
        var glassShellView: NSView?
        let railTopStack: NSStackView
        let headerIconHost: NSStackView
        let headerTitleLabel: NSTextField
        let headerBadgeHost: NSStackView
        let scrollView: GlassScrollView
        let contentHost: FlippedView
        var contentStack: NSStackView?
        let footerLeftLabel: NSTextField
        let footerRightLabel: NSTextField

        init(totalWidth: CGFloat, totalHeight: CGFloat, cornerRadius: CGFloat) {
            self.panel = FloatingPanel(
                contentRect: NSRect(x: 0, y: 0, width: totalWidth, height: totalHeight),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: true
            )
            self.canvasView = GlassCanvasView(cornerRadius: cornerRadius)
            self.railTopStack = UI.vstack(spacing: 4, alignment: .centerX)
            self.headerIconHost = UI.hstack(spacing: 0)
            self.headerTitleLabel = UI.label("总览", size: 17.5, weight: .bold, compressible: true)
            self.headerBadgeHost = UI.hstack(spacing: 6)
            self.scrollView = GlassScrollView()
            self.contentHost = FlippedView()
            self.footerLeftLabel = UI.label("准备就绪", size: 11, color: .secondaryLabelColor, monospacedDigits: true, compressible: true)
            self.footerRightLabel = UI.label("", size: 11, color: .tertiaryLabelColor, monospacedDigits: true)
        }
    }

    private let store: UsageStore
    private var session: PanelSession?
    private var teardownWorkItem: DispatchWorkItem?
    private var manualRefreshObserver: Any?

    private enum AgyInlineMode: Equatable {
        case none
        case saveNew
        case rename(id: String, currentAlias: String)
        case confirmDelete(id: String, alias: String)
    }

    private var selectedTab: NavigationTab = .overview
    private var agyInlineMode: AgyInlineMode = .none
    private weak var activeInlineTextField: NSTextField?
    private var globalClickMonitor: Any?
    private var visibleClockTimer: Timer?

    init(store: UsageStore) {
        self.store = store
        super.init()

        manualRefreshObserver = NotificationCenter.default.addObserver(forName: .aiUsageManualRefresh, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                self.store.triggerRefresh(offlineOnly: self.store.isOfflineMode, forceRemote: !self.store.isOfflineMode)
            }
        }
    }

    deinit {
        if let obs = manualRefreshObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    var isVisible: Bool { session?.panel.isVisible ?? false }

    private func ensureSession() -> PanelSession {
        teardownWorkItem?.cancel()
        teardownWorkItem = nil
        if let existing = session { return existing }
        let totalW = Self.panelWidth + Self.shadowInsets.left + Self.shadowInsets.right
        let totalH = Self.panelHeight + Self.shadowInsets.top + Self.shadowInsets.bottom
        let created = PanelSession(totalWidth: totalW, totalHeight: totalH, cornerRadius: Self.cornerRadius)
        configureWindow(created.panel)
        buildSkeleton(in: created)
        session = created
        return created
    }

    private func tearDownSessionNow() {
        teardownWorkItem?.cancel()
        teardownWorkItem = nil
        guard let s = session, !s.panel.isVisible else { return }
        autoreleasepool {
            s.contentStack?.removeFromSuperview()
            s.contentStack = nil
            s.contentHost.subviews.forEach { $0.removeFromSuperview() }
            s.railTopStack.subviews.forEach { $0.removeFromSuperview() }
            s.headerIconHost.subviews.forEach { $0.removeFromSuperview() }
            s.headerBadgeHost.subviews.forEach { $0.removeFromSuperview() }
            s.scrollView.resetScrollerVisibility()
            s.panel.delegate = nil
            s.panel.onEscape = nil
            s.panel.orderOut(nil)
            s.panel.contentView = nil
            s.panel.close()
            s.glassShellView = nil
            session = nil
        }
        BrandIcons.trimPanelCache()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self = self, self.session == nil else { return }
            MemoryTrim.reclaim()
        }
    }

    func toggle(relativeTo statusButton: NSStatusBarButton?) {
        if isVisible {
            hide()
        } else {
            show(relativeTo: statusButton)
        }
    }

    func showSettings(relativeTo statusButton: NSStatusBarButton?) {
        selectedTab = .settings
        show(relativeTo: statusButton)
    }

    func showProvider(_ name: String, relativeTo statusButton: NSStatusBarButton?) {
        selectedTab = .provider(name)
        show(relativeTo: statusButton)
    }

    func selectTabAndLayout(_ tab: NavigationTab) {
        let s = ensureSession()
        selectedTab = tab
        render()
        s.panel.contentView?.layoutSubtreeIfNeeded()
    }

    func snapshotPNG(appearance: NSAppearance? = nil) -> Data? {
        let s = ensureSession()
        if let app = appearance {
            s.panel.appearance = app
            s.canvasView.appearance = app
        }
        s.panel.contentView?.layoutSubtreeIfNeeded()
        s.canvasView.layoutSubtreeIfNeeded()
        let size = s.canvasView.bounds.size
        guard size.width > 0, size.height > 0,
              let rep = s.canvasView.bitmapImageRepForCachingDisplay(in: s.canvasView.bounds) else { return nil }
        s.canvasView.cacheDisplay(in: s.canvasView.bounds, to: rep)
        let dark = (appearance?.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua) || (appearance == nil && Theme.isDark(s.canvasView))
        let composed = NSImage(size: size, flipped: false) { rect in
            let bgGrad = dark
                ? NSGradient(colors: [
                    NSColor(srgbRed: 0.07, green: 0.12, blue: 0.28, alpha: 1.0),
                    NSColor(srgbRed: 0.18, green: 0.10, blue: 0.30, alpha: 1.0),
                    NSColor(srgbRed: 0.05, green: 0.18, blue: 0.26, alpha: 1.0),
                ])
                : NSGradient(colors: [
                    NSColor(srgbRed: 0.72, green: 0.85, blue: 0.99, alpha: 1.0),
                    NSColor(srgbRed: 0.88, green: 0.80, blue: 0.98, alpha: 1.0),
                    NSColor(srgbRed: 0.74, green: 0.92, blue: 0.95, alpha: 1.0),
                ])
            let clip = NSBezierPath(roundedRect: rect, xRadius: Self.cornerRadius, yRadius: Self.cornerRadius)
            clip.addClip()
            bgGrad?.draw(in: rect, angle: -35)
            rep.draw(in: rect)
            Theme.drawGlassRim(
                in: rect,
                radius: Self.cornerRadius,
                topColor: Theme.rimTop(dark),
                bottomColor: Theme.rimBottom(dark),
                lineWidth: 1.0
            )
            return true
        }
        guard let tiff = composed.tiffRepresentation,
              let finalRep = NSBitmapImageRep(data: tiff) else {
            return rep.representation(using: .png, properties: [:])
        }
        return finalRep.representation(using: .png, properties: [:])
    }

    func show(relativeTo statusButton: NSStatusBarButton?) {
        let s = ensureSession()
        ensureValidTab()
        render()
        positionPanel(s.panel, relativeTo: statusButton)
        s.panel.makeKeyAndOrderFront(nil)
        startMonitors()
        store.refreshOnPanelOpenIfNeeded()
    }

    func hide() {
        stopMonitors()
        agyInlineMode = .none
        activeInlineTextField = nil
        guard let s = session else { return }
        s.panel.orderOut(nil)
        // Immediately release scrolled card/label subviews and AutoLayout constraints on hide.
        autoreleasepool {
            s.contentStack?.removeFromSuperview()
            s.contentStack = nil
            s.contentHost.subviews.forEach { $0.removeFromSuperview() }
            s.scrollView.resetScrollerVisibility()
        }
        teardownWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.tearDownSessionNow()
        }
        teardownWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleTeardownDelaySeconds, execute: work)
    }

    func refreshIfVisible() {
        guard isVisible else { return }
        ensureValidTab()
        render()
    }

    func windowDidResignKey(_ notification: Notification) {
        hide()
    }

    // MARK: - Window & Skeleton
    private func configureWindow(_ panel: FloatingPanel) {
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // Disable legacy rectangular WindowServer shadow (which paints a 1px square corner box
        // behind rounded NSGlassEffectView corners on borderless panels); GlassOuterShadowView
        // draws a crisp exterior-only rounded drop shadow with zero corner artifacts.
        panel.hasShadow = false
        panel.isMovable = false
        panel.delegate = self
        panel.onEscape = { [weak self] in
            guard let self = self else { return }
            if self.agyInlineMode != .none {
                self.agyInlineMode = .none
                self.activeInlineTextField = nil
                self.render()
            } else {
                self.hide()
            }
        }
    }

    private func buildSkeleton(in s: PanelSession) {
        let root = s.canvasView
        let outerHost = NSView()
        outerHost.wantsLayer = true
        outerHost.layer?.backgroundColor = NSColor.clear.cgColor
        outerHost.layer?.masksToBounds = false

        let shadowView = GlassOuterShadowView(cornerRadius: Self.cornerRadius, insets: Self.shadowInsets)
        let shellPair = GlassShellFactory.makeRootShell(cornerRadius: Self.cornerRadius, contentView: root)
        let shell = shellPair.container
        s.glassShellView = shellPair.glassView

        outerHost.addSubview(shadowView)
        outerHost.addSubview(shell)
        NSLayoutConstraint.activate([
            shadowView.leadingAnchor.constraint(equalTo: outerHost.leadingAnchor),
            shadowView.trailingAnchor.constraint(equalTo: outerHost.trailingAnchor),
            shadowView.topAnchor.constraint(equalTo: outerHost.topAnchor),
            shadowView.bottomAnchor.constraint(equalTo: outerHost.bottomAnchor),

            shell.leadingAnchor.constraint(equalTo: outerHost.leadingAnchor, constant: Self.shadowInsets.left),
            shell.trailingAnchor.constraint(equalTo: outerHost.trailingAnchor, constant: -Self.shadowInsets.right),
            shell.topAnchor.constraint(equalTo: outerHost.topAnchor, constant: Self.shadowInsets.top),
            shell.bottomAnchor.constraint(equalTo: outerHost.bottomAnchor, constant: -Self.shadowInsets.bottom),
        ])
        s.panel.contentView = outerHost

        // Left floating glass navigation rail (58pt)
        let railContainer = SurfaceView(kind: .sidebar)
        root.addSubview(railContainer)

        let railBottomStack = UI.vstack(spacing: 4, alignment: .centerX)
        let refreshBtn = RailItemButton()
        refreshBtn.icon = BrandIcons.refreshIcon()
        refreshBtn.toolTip = "立即刷新 (⌘R)"
        refreshBtn.onClick = { [weak self] in
            guard let self = self else { return }
            self.store.triggerRefresh(offlineOnly: self.store.isOfflineMode, forceRemote: !self.store.isOfflineMode)
        }

        let settingsBtn = RailItemButton()
        settingsBtn.tag = 999
        settingsBtn.icon = BrandIcons.navIcon(for: .settings, active: false)
        settingsBtn.toolTip = "设置"
        settingsBtn.onClick = { [weak self] in
            self?.selectedTab = .settings
            self?.render()
        }
        railBottomStack.addArrangedSubview(refreshBtn)
        railBottomStack.addArrangedSubview(settingsBtn)

        railContainer.addSubview(s.railTopStack)
        railContainer.addSubview(railBottomStack)

        let railDivider = UI.hairline(vertical: true)
        root.addSubview(railDivider)

        // Right content canvas
        let rightContainer = NSView()
        rightContainer.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(rightContainer)

        // Airy Header (no harsh bottom border — clean OpenUsage editorial spacing)
        let headerView = NSView()
        headerView.translatesAutoresizingMaskIntoConstraints = false
        rightContainer.addSubview(headerView)

        let headerLeft = UI.hstack(spacing: 8)
        headerLeft.addArrangedSubview(s.headerIconHost)
        headerLeft.addArrangedSubview(s.headerTitleLabel)
        headerView.addSubview(headerLeft)
        headerView.addSubview(s.headerBadgeHost)

        // Scrollable body locked strictly to viewport width so nothing ever clips horizontally
        s.scrollView.drawsBackground = false
        s.scrollView.hasVerticalScroller = true
        s.scrollView.hasHorizontalScroller = false
        s.scrollView.autohidesScrollers = true
        s.scrollView.borderType = .noBorder
        s.scrollView.translatesAutoresizingMaskIntoConstraints = false
        s.contentHost.translatesAutoresizingMaskIntoConstraints = false
        s.contentHost.wantsLayer = true
        s.contentHost.layer?.backgroundColor = NSColor.clear.cgColor
        s.scrollView.documentView = s.contentHost
        rightContainer.addSubview(s.scrollView)

        // Subtle Footer
        let footerDivider = UI.hairline(vertical: false)
        rightContainer.addSubview(footerDivider)

        let footerView = NSView()
        footerView.translatesAutoresizingMaskIntoConstraints = false
        rightContainer.addSubview(footerView)
        footerView.addSubview(s.footerLeftLabel)
        footerView.addSubview(s.footerRightLabel)

        NSLayoutConstraint.activate([
            railContainer.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            railContainer.topAnchor.constraint(equalTo: root.topAnchor),
            railContainer.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            railContainer.widthAnchor.constraint(equalToConstant: Self.sidebarWidth),

            s.railTopStack.topAnchor.constraint(equalTo: railContainer.topAnchor, constant: 13),
            s.railTopStack.centerXAnchor.constraint(equalTo: railContainer.centerXAnchor),

            railBottomStack.bottomAnchor.constraint(equalTo: railContainer.bottomAnchor, constant: -13),
            railBottomStack.centerXAnchor.constraint(equalTo: railContainer.centerXAnchor),

            railDivider.leadingAnchor.constraint(equalTo: railContainer.trailingAnchor),
            railDivider.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            railDivider.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),

            rightContainer.leadingAnchor.constraint(equalTo: railDivider.trailingAnchor),
            rightContainer.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            rightContainer.topAnchor.constraint(equalTo: root.topAnchor),
            rightContainer.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            headerView.leadingAnchor.constraint(equalTo: rightContainer.leadingAnchor),
            headerView.trailingAnchor.constraint(equalTo: rightContainer.trailingAnchor),
            headerView.topAnchor.constraint(equalTo: rightContainer.topAnchor, constant: 4),
            headerView.heightAnchor.constraint(equalToConstant: 46),

            headerLeft.leadingAnchor.constraint(equalTo: headerView.leadingAnchor, constant: 16),
            headerLeft.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),

            s.headerBadgeHost.trailingAnchor.constraint(equalTo: headerView.trailingAnchor, constant: -16),
            s.headerBadgeHost.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            s.headerBadgeHost.leadingAnchor.constraint(greaterThanOrEqualTo: headerLeft.trailingAnchor, constant: 8),

            footerView.leadingAnchor.constraint(equalTo: rightContainer.leadingAnchor),
            footerView.trailingAnchor.constraint(equalTo: rightContainer.trailingAnchor),
            footerView.bottomAnchor.constraint(equalTo: rightContainer.bottomAnchor),
            footerView.heightAnchor.constraint(equalToConstant: 32),

            s.footerLeftLabel.leadingAnchor.constraint(equalTo: footerView.leadingAnchor, constant: 16),
            s.footerLeftLabel.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),

            s.footerRightLabel.trailingAnchor.constraint(equalTo: footerView.trailingAnchor, constant: -16),
            s.footerRightLabel.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
            s.footerRightLabel.leadingAnchor.constraint(greaterThanOrEqualTo: s.footerLeftLabel.trailingAnchor, constant: 8),

            footerDivider.leadingAnchor.constraint(equalTo: rightContainer.leadingAnchor),
            footerDivider.trailingAnchor.constraint(equalTo: rightContainer.trailingAnchor),
            footerDivider.bottomAnchor.constraint(equalTo: footerView.topAnchor),

            s.scrollView.leadingAnchor.constraint(equalTo: rightContainer.leadingAnchor),
            s.scrollView.trailingAnchor.constraint(equalTo: rightContainer.trailingAnchor),
            s.scrollView.topAnchor.constraint(equalTo: headerView.bottomAnchor),
            s.scrollView.bottomAnchor.constraint(equalTo: footerDivider.topAnchor),

            s.contentHost.leadingAnchor.constraint(equalTo: s.scrollView.contentView.leadingAnchor),
            s.contentHost.trailingAnchor.constraint(equalTo: s.scrollView.contentView.trailingAnchor),
            s.contentHost.widthAnchor.constraint(equalTo: s.scrollView.contentView.widthAnchor),
            s.contentHost.topAnchor.constraint(equalTo: s.scrollView.contentView.topAnchor),
        ])
    }

    private func positionPanel(_ panel: FloatingPanel, relativeTo statusButton: NSStatusBarButton?) {
        guard let button = statusButton, let buttonWindow = button.window else {
            panel.center()
            return
        }
        let buttonRectInScreen = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let screen = buttonWindow.screen ?? NSScreen.main
        let visibleFrame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        let totalSize = panel.frame.size
        var x = buttonRectInScreen.midX - totalSize.width / 2.0
        let minX = visibleFrame.minX + 8 - Self.shadowInsets.left
        let maxX = visibleFrame.maxX - totalSize.width - 8 + Self.shadowInsets.right
        x = max(minX, min(x, maxX))
        let y = buttonRectInScreen.minY - (Self.panelHeight + Self.shadowInsets.bottom) - 4
        panel.setFrameOrigin(NSPoint(x: x.rounded(), y: y.rounded()))
    }

    private func startMonitors() {
        stopMonitors()
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in
                self?.hide()
            }
        }
        let timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                self.updateFooter()
                if !self.store.isOfflineMode, !self.store.isDemoMode, !self.store.isRefreshing,
                   let next = self.store.nextQuotaRefreshDate, next <= Date() {
                    self.store.triggerRefresh(offlineOnly: false, forceRemote: false)
                }
            }
        }
        timer.tolerance = 5
        visibleClockTimer = timer
    }

    private func stopMonitors() {
        if let monitor = globalClickMonitor {
            NSEvent.removeMonitor(monitor)
            globalClickMonitor = nil
        }
        visibleClockTimer?.invalidate()
        visibleClockTimer = nil
    }

    private func ensureValidTab() {
        if case .provider(let name) = selectedTab, !store.isProviderVisible(name) {
            selectedTab = .overview
        }
    }

    // MARK: - Render Dispatcher
    func render() {
        guard let s = session else { return }
        s.canvasView.activeTab = selectedTab
        GlassShellFactory.updateTint(on: s.glassShellView, for: selectedTab)
        renderRail(in: s)
        renderHeader(in: s)
        renderBody(in: s)
        updateFooter()
    }

    private func renderRail(in s: PanelSession) {
        s.railTopStack.subviews.forEach { $0.removeFromSuperview() }

        let homeBtn = RailItemButton()
        let isHome = (selectedTab == .overview)
        homeBtn.icon = BrandIcons.navIcon(for: .overview, active: isHome)
        homeBtn.isSelected = isHome
        homeBtn.toolTip = "总览"
        homeBtn.onClick = { [weak self] in
            self?.selectedTab = .overview
            self?.render()
        }
        s.railTopStack.addArrangedSubview(homeBtn)

        let providerMap = Dictionary(uniqueKeysWithValues: (store.payload?.providers ?? []).map { ($0.name, $0) })
        for name in UsageStore.allProviders where store.isProviderVisible(name) {
            let btn = RailItemButton()
            let active = (selectedTab == .provider(name))
            btn.icon = BrandIcons.providerIcon(name)
            btn.providerName = name
            btn.isSelected = active
            btn.toolTip = name
            if let dto = providerMap[name], !dto.skipped {
                btn.statusDotColor = providerWarningDotColor(dto)
            }
            btn.onClick = { [weak self] in
                self?.selectedTab = .provider(name)
                self?.render()
            }
            s.railTopStack.addArrangedSubview(btn)
        }

        if let settingsBtn = s.panel.contentView?.viewWithTag(999) as? RailItemButton {
            let isSettings = (selectedTab == .settings)
            settingsBtn.isSelected = isSettings
            settingsBtn.icon = BrandIcons.navIcon(for: .settings, active: isSettings)
        }
    }

    /// Only show rail dots when attention is genuinely needed (keeps normal UI calm & clean)
    private func compactAccountBadge(_ alias: String) -> String {
        if alias.contains("@"), let prefix = alias.split(separator: "@").first, !prefix.isEmpty, alias.count > 18 {
            return String(prefix)
        }
        return alias
    }

    private func providerWarningDotColor(_ dto: ProviderDto) -> NSColor? {
        if dto.error != nil { return .systemOrange }
        let maxUsed = dto.windows.compactMap(\.usedPercent).max() ?? 0
        let hasCritPace = dto.windows.contains { $0.pace?.status == "critical" }
        if maxUsed >= 85 || hasCritPace { return .systemRed }
        if maxUsed >= 65 { return .systemOrange }
        return nil
    }

    private func renderHeader(in s: PanelSession) {
        s.headerIconHost.subviews.forEach { $0.removeFromSuperview() }
        s.headerBadgeHost.subviews.forEach { $0.removeFromSuperview() }

        if store.isDemoMode {
            s.headerBadgeHost.addArrangedSubview(UI.pillBadge("示例", textColor: .systemBlue, bgColor: NSColor.systemBlue.withAlphaComponent(0.12)))
        } else if store.isOfflineMode {
            s.headerBadgeHost.addArrangedSubview(UI.pillBadge("离线", textColor: .secondaryLabelColor))
        }

        switch selectedTab {
        case .overview:
            s.headerTitleLabel.stringValue = "总览"
        case .settings:
            s.headerTitleLabel.stringValue = "设置"
        case .provider(let name):
            s.headerIconHost.addArrangedSubview(BrandBadgeView(provider: name, size: 24))
            s.headerTitleLabel.stringValue = name
            let dto = store.payload?.providers.first(where: { $0.name == name })
            if let plan = dto?.plan, !plan.isEmpty {
                s.headerBadgeHost.addArrangedSubview(UI.pillBadge(plan, textColor: .labelColor))
            } else if name == "agy",
                      let alias = dto?.account?.alias ?? store.agyAccounts?.activeAccount?.alias,
                      !alias.isEmpty {
                let badge = UI.pillBadge(compactAccountBadge(alias), textColor: .labelColor)
                badge.toolTip = alias
                s.headerBadgeHost.addArrangedSubview(badge)
            }
        }
    }

    private func renderBody(in s: PanelSession) {
        s.scrollView.resetScrollerVisibility()
        if s.panel.firstResponder is NSTextView {
            s.panel.makeFirstResponder(nil)
        }
        activeInlineTextField = nil
        s.contentStack?.removeFromSuperview()
        s.contentHost.subviews.forEach { $0.removeFromSuperview() }
        let stack = UI.vstack(spacing: 12)
        s.contentHost.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: s.contentHost.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: s.contentHost.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: s.contentHost.topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: s.contentHost.bottomAnchor, constant: -16),
        ])
        s.contentStack = stack

        let now = Date()
        switch selectedTab {
        case .overview:
            buildOverviewBody(into: stack, now: now)
        case .provider(let name):
            let dto = store.payload?.providers.first(where: { $0.name == name })
            buildProviderBody(dto, name: name, into: stack, now: now)
        case .settings:
            buildSettingsBody(into: stack)
        }
        s.contentHost.layoutSubtreeIfNeeded()
        s.contentHost.needsDisplay = true
        s.scrollView.contentView.needsDisplay = true
    }

    // MARK: - Overview Tab
    private func buildOverviewBody(into stack: NSStackView, now: Date) {
        let today = store.filteredPeriodCost(\.today, rawKeyPath: \.today)
        let days7 = store.filteredPeriodCost(\.days7, rawKeyPath: \.days7)
        let days30 = store.filteredPeriodCost(\.days30, rawKeyPath: \.days30)

        let (costCard, costStack) = UI.cardContainer(padding: 12, spacing: 8)
        let titleRow = UI.hstack(spacing: 6)
        titleRow.addArrangedSubview(UI.label("本机 Token 与等价 API 统计", size: 11.5, weight: .semibold, color: .secondaryLabelColor))
        titleRow.addArrangedSubview(UI.spacer())
        titleRow.addArrangedSubview(UI.label("非套餐扣费", size: 10.5, color: .tertiaryLabelColor))
        costStack.addArrangedSubview(titleRow)
        titleRow.widthAnchor.constraint(equalTo: costStack.widthAnchor).isActive = true

        let grid = buildThreePeriodGrid(
            today: (today.usd, today.tokens, today.priced, today.unpriced, today.incomplete),
            days7: (days7.usd, days7.tokens, days7.priced, days7.unpriced, days7.incomplete),
            days30: (days30.usd, days30.tokens, days30.priced, days30.unpriced, days30.incomplete)
        )
        costStack.addArrangedSubview(grid)
        grid.widthAnchor.constraint(equalTo: costStack.widthAnchor).isActive = true
        stack.addArrangedSubview(costCard)
        costCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let providers = store.visibleProviders
        if providers.isEmpty {
            let (emptyCard, emptyStack) = UI.cardContainer(padding: 13, spacing: 6)
            let msg = store.isRefreshing
                ? "正在读取额度与本机日志…"
                : "尚未检测到已登录的服务 · 在终端登录 Claude / Codex / Grok / agy 后将自动显示。"
            let lbl = UI.label(msg, size: 12, color: .secondaryLabelColor, wraps: true)
            emptyStack.addArrangedSubview(lbl)
            lbl.widthAnchor.constraint(equalTo: emptyStack.widthAnchor).isActive = true
            stack.addArrangedSubview(emptyCard)
            emptyCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            return
        }

        for dto in providers {
            let card = ClickableCardView()
            card.providerName = dto.name
            card.translatesAutoresizingMaskIntoConstraints = false
            let targetName = dto.name
            card.onClick = { [weak self] in
                self?.selectedTab = .provider(targetName)
                self?.render()
            }

            let inner = UI.vstack(spacing: 9.5)
            card.addSubview(inner)
            NSLayoutConstraint.activate([
                inner.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 13),
                inner.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -13),
                inner.topAnchor.constraint(equalTo: card.topAnchor, constant: 12),
                inner.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
            ])

            // Provider Header Row inside Card
            let top = UI.hstack(spacing: 8)
            top.addArrangedSubview(BrandBadgeView(provider: dto.name, size: 22))
            top.addArrangedSubview(UI.label(dto.name, size: 13.5, weight: .semibold, compressible: true))
            if let plan = dto.plan, !plan.isEmpty {
                top.addArrangedSubview(UI.pillBadge(plan, textColor: .secondaryLabelColor))
            } else if dto.name == "agy",
                      let alias = dto.account?.alias ?? store.agyAccounts?.activeAccount?.alias,
                      !alias.isEmpty {
                let badge = UI.pillBadge(compactAccountBadge(alias), textColor: .secondaryLabelColor)
                badge.toolTip = alias
                top.addArrangedSubview(badge)
            }
            top.addArrangedSubview(UI.spacer())

            if dto.supportsTokens, let t = dto.tokens, t.today > 0 {
                let d = t.usage?.today
                let costStr = Formatters.formatUSD(d?.costUsd, pricedTokens: d?.pricedTokens, unpricedTokens: d?.unpricedTokens)
                let summaryRight = (costStr == "—") ? "今日 \(Formatters.formatTokens(t.today))" : "今日 \(costStr)"
                top.addArrangedSubview(UI.label(summaryRight, size: 11.5, weight: .medium, color: .secondaryLabelColor, monospacedDigits: true))
            }
            top.addArrangedSubview(UI.label("›", size: 14, weight: .medium, color: .tertiaryLabelColor))
            inner.addArrangedSubview(top)
            top.widthAnchor.constraint(equalTo: inner.widthAnchor).isActive = true

            if dto.skipped {
                inner.addArrangedSubview(UI.label("尚未登录 · 请在终端登录对应 CLI", size: 11.5, color: .tertiaryLabelColor))
            } else if dto.windows.isEmpty {
                let msg = dto.error ?? "暂无额度窗口"
                let lbl = UI.label(msg, size: 11.5, color: dto.error != nil ? .systemOrange : .secondaryLabelColor, wraps: true)
                inner.addArrangedSubview(lbl)
                lbl.widthAnchor.constraint(equalTo: inner.widthAnchor).isActive = true
            } else {
                let displayWins = selectOverviewWindows(dto.windows)
                for win in displayWins {
                    let row = UI.buildWindowRow(win, providerName: dto.name, now: now, compact: true)
                    inner.addArrangedSubview(row)
                    row.widthAnchor.constraint(equalTo: inner.widthAnchor).isActive = true
                }
            }

            stack.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    private func selectOverviewWindows(_ windows: [WindowDto]) -> [WindowDto] {
        if windows.count <= 2 { return windows }
        // Prioritize highest usedPercent windows so overview stays compact & scannable
        let sorted = windows.enumerated().sorted { lhs, rhs in
            let lu = lhs.element.usedPercent ?? -1
            let ru = rhs.element.usedPercent ?? -1
            if abs(lu - ru) > 0.01 { return lu > ru }
            return lhs.offset < rhs.offset
        }
        return Array(sorted.prefix(2).map(\.element))
    }

    // MARK: - Provider Detail Tab
    private func buildProviderBody(_ dto: ProviderDto?, name: String, into stack: NSStackView, now: Date) {
        if name == "agy" {
            buildAgyAccountCard(into: stack)
        }

        guard let dto = dto else {
            stack.addArrangedSubview(UI.label("正在加载 \(name) 数据…", size: 12.5, color: .secondaryLabelColor))
            return
        }

        // 1. Quota Windows Card
        if dto.skipped {
            let (card, s) = UI.cardContainer()
            s.addArrangedSubview(UI.label("尚未登录 \(name)", size: 13, weight: .semibold))
            let hint = UI.label("请先在终端完成对应 CLI 登录，AIUsage 会自动同步套餐额度与本机日志。", size: 11.5, color: .secondaryLabelColor, wraps: true)
            s.addArrangedSubview(hint)
            hint.widthAnchor.constraint(equalTo: s.widthAnchor).isActive = true
            stack.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        } else if dto.windows.isEmpty {
            let (card, s) = UI.cardContainer()
            let errText = dto.error ?? (dto.quota?.status == "offline" ? "离线模式 · 暂无已保存的额度快照" : "暂无额度窗口")
            let lbl = UI.label(errText, size: 12, color: dto.error != nil ? .systemOrange : .secondaryLabelColor, wraps: true)
            s.addArrangedSubview(lbl)
            lbl.widthAnchor.constraint(equalTo: s.widthAnchor).isActive = true
            stack.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        } else {
            let (qCard, qStack) = UI.cardContainer(padding: 13, spacing: 13)
            for (idx, win) in dto.windows.enumerated() {
                if idx > 0 {
                    let sep = UI.hairline(vertical: false)
                    qStack.addArrangedSubview(sep)
                    sep.widthAnchor.constraint(equalTo: qStack.widthAnchor).isActive = true
                }
                let row = UI.buildWindowRow(win, providerName: name, now: now, compact: false)
                qStack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: qStack.widthAnchor).isActive = true
            }
            if let err = dto.error, !err.isEmpty {
                let warn = UI.label("提示：\(err)", size: 11, color: .systemOrange, wraps: true)
                qStack.addArrangedSubview(warn)
                warn.widthAnchor.constraint(equalTo: qStack.widthAnchor).isActive = true
            }
            stack.addArrangedSubview(qCard)
            qCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        // 2. Reset Credits Card
        if let rc = dto.resetCredits, (rc.count ?? 0) > 0 || rc.error != nil {
            let (rcCard, rcStack) = UI.cardContainer(padding: 12, spacing: 7)
            let head = UI.hstack(spacing: 6)
            head.addArrangedSubview(UI.label("重置卡库存", size: 12, weight: .semibold, color: .secondaryLabelColor))
            head.addArrangedSubview(UI.spacer())
            let countLabel = rc.count.map { "\($0) 张" } ?? "未知"
            head.addArrangedSubview(UI.pillBadge(countLabel, textColor: .labelColor))
            rcStack.addArrangedSubview(head)
            head.widthAnchor.constraint(equalTo: rcStack.widthAnchor).isActive = true

            if let app = rc.applicableCount, app != rc.count {
                rcStack.addArrangedSubview(UI.label("当前窗口可用：\(app) 张", size: 11.5, color: .secondaryLabelColor))
            }
            for batch in (rc.credits ?? []).prefix(5) {
                let expText = batch.expiresAtDate.map { "到期 \(Formatters.formatWhen($0, now: now))" } ?? "到期时间未提供"
                rcStack.addArrangedSubview(UI.label("• \(batch.count) 张 · \(expText)", size: 11.5, color: .secondaryLabelColor, monospacedDigits: true))
            }
            if let rcErr = rc.error {
                let errLbl = UI.label("查询失败：\(rcErr)", size: 11, color: .systemOrange, wraps: true)
                rcStack.addArrangedSubview(errLbl)
                errLbl.widthAnchor.constraint(equalTo: rcStack.widthAnchor).isActive = true
            }
            stack.addArrangedSubview(rcCard)
            rcCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        // 3. Local Token & Cache Breakdown Card (now works for Claude, Codex, Grok, AND agy!)
        if dto.supportsTokens, let t = dto.tokens {
            let (tokCard, tokStack) = UI.cardContainer(padding: 12, spacing: 9)
            let head = UI.hstack(spacing: 6)
            head.addArrangedSubview(UI.label("本机 Token 与缓存用量", size: 12, weight: .semibold, color: .secondaryLabelColor))
            head.addArrangedSubview(UI.spacer())
            if let hit30 = t.usage?.days30?.cacheHitRateText {
                head.addArrangedSubview(UI.pillBadge("30天缓存命中 \(hit30)", textColor: .secondaryLabelColor))
            }
            tokStack.addArrangedSubview(head)
            head.widthAnchor.constraint(equalTo: tokStack.widthAnchor).isActive = true

            let uToday = t.usage?.today
            let u7 = t.usage?.days7
            let u30 = t.usage?.days30
            let grid = buildThreePeriodGrid(
                today: (uToday?.costUsd ?? 0, t.today, uToday?.pricedTokens ?? 0, uToday?.unpricedTokens ?? 0, false),
                days7: (u7?.costUsd ?? 0, t.days7, u7?.pricedTokens ?? 0, u7?.unpricedTokens ?? 0, false),
                days30: (u30?.costUsd ?? 0, t.days30, u30?.pricedTokens ?? 0, u30?.unpricedTokens ?? 0, false)
            )
            tokStack.addArrangedSubview(grid)
            grid.widthAnchor.constraint(equalTo: tokStack.widthAnchor).isActive = true

            if !t.models.isEmpty {
                for m in t.models {
                    let divider = UI.hairline(vertical: false)
                    tokStack.addArrangedSubview(divider)
                    divider.widthAnchor.constraint(equalTo: tokStack.widthAnchor).isActive = true

                    let mStack = UI.vstack(spacing: 3)
                    let line1 = UI.hstack(spacing: 6)
                    line1.addArrangedSubview(UI.label(Formatters.shortModel(m.model), size: 12.5, weight: .medium, compressible: true))
                    if let hit = m.usage?.days30?.cacheHitRateText {
                        line1.addArrangedSubview(UI.pillBadge("命中 \(hit)", textColor: .secondaryLabelColor))
                    }
                    line1.addArrangedSubview(UI.spacer())
                    let m30 = m.usage?.days30
                    let cost30 = Formatters.formatUSD(m30?.costUsd, pricedTokens: m30?.pricedTokens, unpricedTokens: m30?.unpricedTokens)
                    let rightHeadline = (cost30 == "—") ? "\(Formatters.formatTokens(m.days30)) tok" : cost30
                    line1.addArrangedSubview(UI.label(rightHeadline, size: 12, weight: .semibold, color: .labelColor, monospacedDigits: true))
                    mStack.addArrangedSubview(line1)
                    line1.widthAnchor.constraint(equalTo: mStack.widthAnchor).isActive = true

                    let read30 = Formatters.formatTokens(m30?.cacheReadTokens)
                    let write30 = Formatters.formatTokens(m30?.cacheWriteTokens)
                    let subText = (m30?.cacheWriteTokens ?? 0) > 0
                        ? "今日 \(Formatters.formatTokens(m.today)) · 读缓存 \(read30) · 写 \(write30)"
                        : "今日 \(Formatters.formatTokens(m.today)) · 30天读缓存 \(read30)"
                    mStack.addArrangedSubview(UI.label(subText, size: 11, color: .secondaryLabelColor, monospacedDigits: true, compressible: true))

                    tokStack.addArrangedSubview(mStack)
                    mStack.widthAnchor.constraint(equalTo: tokStack.widthAnchor).isActive = true
                }
            } else if t.days30 == 0 {
                tokStack.addArrangedSubview(UI.label("近 30 天暂无本机对话记录", size: 11.5, color: .tertiaryLabelColor))
            }

            stack.addArrangedSubview(tokCard)
            tokCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    private func buildAgyAccountCard(into stack: NSStackView) {
        let info = store.agyAccounts
        let accounts = info?.accounts ?? []
        let busy = store.isAgyAccountBusy
        let (card, cardStack) = UI.cardContainer(padding: 12, spacing: 8)

        // Header Row: title + Save Current + Logout for new account
        let head = UI.hstack(spacing: 6)
        head.addArrangedSubview(UI.label("本机 agy 账号", size: 12, weight: .semibold, color: .secondaryLabelColor))
        head.addArrangedSubview(UI.spacer())

        if busy {
            head.addArrangedSubview(UI.label("处理中…", size: 11, color: .secondaryLabelColor))
        } else {
            if !accounts.isEmpty && (info?.loggedIn != false) {
                let logoutBtn = GlassPillButton(title: "换号登录", tone: .neutral, compact: true) { [weak self] in
                    self?.onAgyPrepareLogout()
                }
                logoutBtn.toolTip = "保存并清空当前登录，方便在终端运行 agy 登录第二个账号"
                head.addArrangedSubview(logoutBtn)
            }
            let saveBtn = GlassPillButton(title: "+ 保存当前", tone: .accent, compact: true) { [weak self] in
                self?.onAgyStartSave()
            }
            saveBtn.toolTip = "将当前 agy 钥匙串票据保存到本机列表"
            head.addArrangedSubview(saveBtn)
        }
        cardStack.addArrangedSubview(head)
        head.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true

        // Inline confirmation bar (Delete) — Rename renders cleanly in-place on the target account row below!
        if case .confirmDelete(_, let alias) = agyInlineMode {
            let confirmRow = UI.hstack(spacing: 6)
            let msg = UI.label("删除「\(alias)」的保存票据？", size: 11.5, color: .systemRed, compressible: true)
            confirmRow.addArrangedSubview(msg)
            confirmRow.addArrangedSubview(UI.spacer())
            let okBtn = GlassPillButton(title: "确认删除", tone: .destructive, compact: true) { [weak self] in
                self?.onAgyConfirmDelete()
            }
            let cancelBtn = GlassPillButton(title: "取消", tone: .neutral, compact: true) { [weak self] in
                self?.onAgyInlineCancel()
            }
            confirmRow.addArrangedSubview(okBtn)
            confirmRow.addArrangedSubview(cancelBtn)
            cardStack.addArrangedSubview(confirmRow)
            confirmRow.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
        }

        // Conflict resolution bar (unsaved active account protection)
        if let conflict = store.agyConflict {
            let conflictBox = UI.vstack(spacing: 6)
            let conflictText: String
            let forceTitle: String
            switch conflict {
            case .unsavedSwitch(_, let targetAlias):
                conflictText = "当前登录的 agy 账号尚未保存，直接切到「\(targetAlias)」会覆盖它："
                forceTitle = "仍要覆盖"
            case .unsavedLogout:
                conflictText = "当前登录的 agy 账号尚未保存，直接登出会清空它："
                forceTitle = "仍要登出"
            }
            let cLbl = UI.label(conflictText, size: 11, color: .systemOrange, wraps: true)
            conflictBox.addArrangedSubview(cLbl)
            cLbl.widthAnchor.constraint(equalTo: conflictBox.widthAnchor).isActive = true

            let actRow = UI.hstack(spacing: 6)
            let saveFirstBtn = GlassPillButton(title: "先保存当前号", tone: .accent, compact: true) { [weak self] in
                self?.onAgyStartSave()
            }
            let forceBtn = GlassPillButton(title: forceTitle, tone: .destructive, compact: true) { [weak self] in
                self?.onAgyResolveConflictForce()
            }
            let dismissBtn = GlassPillButton(title: "取消", tone: .neutral, compact: true) { [weak self] in
                self?.onAgyDismissConflict()
            }
            actRow.addArrangedSubview(saveFirstBtn)
            actRow.addArrangedSubview(forceBtn)
            actRow.addArrangedSubview(UI.spacer())
            actRow.addArrangedSubview(dismissBtn)
            conflictBox.addArrangedSubview(actRow)
            actRow.widthAnchor.constraint(equalTo: conflictBox.widthAnchor).isActive = true

            cardStack.addArrangedSubview(conflictBox)
            conflictBox.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
        }

        // Account rows or onboarding hint
        if accounts.isEmpty {
            let hint = UI.label(
                "点击右上角「+ 保存当前」把本机 agy 钥匙串票据存下来，之后一键手动切号（不做 API 反代）。",
                size: 11.5,
                color: .secondaryLabelColor,
                wraps: true
            )
            cardStack.addArrangedSubview(hint)
            hint.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
        } else {
            for (idx, account) in accounts.enumerated() {
                if idx > 0 {
                    let sep = UI.hairline(vertical: false)
                    cardStack.addArrangedSubview(sep)
                    sep.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
                }
                if case .rename(let renameId, let currentAlias) = agyInlineMode, renameId == account.id {
                    let editor = buildAgyInlineInputRow(
                        placeholder: "输入别名（留空直接显示邮箱）",
                        initialValue: currentAlias,
                        confirmTitle: "确定"
                    )
                    cardStack.addArrangedSubview(editor)
                    editor.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
                } else {
                    let row = buildAgyAccountRow(account, disabled: busy)
                    cardStack.addArrangedSubview(row)
                    row.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
                }
            }

            if info?.liveStatus == "unsaved" || info?.keychainChanged == true {
                let unsavedHint = UI.label(
                    "检测到系统钥匙串中的 agy 登录已变动，可点「+ 保存当前」加入或更新列表。",
                    size: 11,
                    color: .systemOrange,
                    wraps: true
                )
                cardStack.addArrangedSubview(unsavedHint)
                unsavedHint.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
            } else if info?.liveStatus == "logged_out" {
                let loggedOutHint = UI.label(
                    "当前未登录 agy · 可在终端运行 agy 登录新账号，或点上方「切换」恢复已有账号。",
                    size: 11,
                    color: .secondaryLabelColor,
                    wraps: true
                )
                cardStack.addArrangedSubview(loggedOutHint)
                loggedOutHint.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
            }
        }

        // Stale (old-account) agy process helper & auto-guard status strip — never targets current-account windows.
        if accounts.count >= 1, let info = info {
            let stale = info.staleAgyCount
            let guarded = info.autoGuard
            if stale > 0 || (accounts.count >= 2 && guarded) {
                let sep = UI.hairline(vertical: false)
                cardStack.addArrangedSubview(sep)
                sep.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true

                let statusRow = UI.hstack(spacing: 6)
                let statusText: String
                if stale > 0 && guarded {
                    statusText = "防覆写已开 · \(stale) 个旧账号 agy 运行中"
                } else if stale > 0 {
                    statusText = "\(stale) 个旧账号 agy 进程运行中"
                } else {
                    statusText = "切号防旧进程覆写保护已开启"
                }
                statusRow.addArrangedSubview(UI.label(statusText, size: 11, color: .secondaryLabelColor, compressible: true))
                statusRow.addArrangedSubview(UI.spacer())

                if stale > 0 && !busy {
                    let stopBtn = GlassPillButton(title: "关闭旧 agy", tone: .neutral, compact: true) { [weak self] in
                        self?.store.stopRunningAgyProcesses()
                    }
                    stopBtn.toolTip = "仅向切号/登出前遗留的 \(stale) 个旧账号 agy 进程发送温和退出信号（SIGTERM），不会关闭当前账号的窗口"
                    statusRow.addArrangedSubview(stopBtn)
                }
                cardStack.addArrangedSubview(statusRow)
                statusRow.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
            }
        }

        // Action result notice
        if let notice = store.agyNotice {
            let div = UI.hairline(vertical: false)
            cardStack.addArrangedSubview(div)
            div.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true

            let noticeRow = UI.hstack(spacing: 6, alignment: .top)
            let msgLbl = UI.label(
                notice.text,
                size: 11,
                color: notice.isError ? .systemOrange : .secondaryLabelColor,
                wraps: true
            )
            noticeRow.addArrangedSubview(msgLbl)
            let closeBtn = NSButton(title: "×", target: self, action: #selector(onAgyDismissNotice))
            closeBtn.isBordered = false
            closeBtn.font = NSFont.systemFont(ofSize: 12, weight: .medium)
            closeBtn.contentTintColor = .tertiaryLabelColor
            noticeRow.addArrangedSubview(closeBtn)
            cardStack.addArrangedSubview(noticeRow)
            noticeRow.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
        }

        stack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    private func buildAgyInlineInputRow(placeholder: String, initialValue: String, confirmTitle: String) -> NSView {
        let row = UI.hstack(spacing: 6)
        let field = NSTextField(string: initialValue)
        field.placeholderString = placeholder
        field.font = NSFont.systemFont(ofSize: 12)
        field.controlSize = .small
        field.isBezeled = true
        field.bezelStyle = .roundedBezel
        field.drawsBackground = true
        field.focusRingType = .exterior
        field.translatesAutoresizingMaskIntoConstraints = false
        field.heightAnchor.constraint(equalToConstant: 24).isActive = true
        field.target = self
        field.action = #selector(onAgyInlineSubmit)
        field.setContentHuggingPriority(.init(1), for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        activeInlineTextField = field

        let submitBtn = GlassPillButton(title: confirmTitle, tone: .accent, compact: true) { [weak self] in
            self?.onAgyInlineSubmit()
        }
        let cancelBtn = GlassPillButton(title: "取消", tone: .neutral, compact: true) { [weak self] in
            self?.onAgyInlineCancel()
        }

        row.addArrangedSubview(field)
        row.addArrangedSubview(submitBtn)
        row.addArrangedSubview(cancelBtn)

        DispatchQueue.main.async { [weak self, weak field] in
            guard let self = self, let field = field, let panel = self.session?.panel, panel.isVisible else { return }
            NSApp.activate(ignoringOtherApps: true)
            panel.makeFirstResponder(field)
            field.currentEditor()?.selectAll(nil)
        }
        return row
    }

    private func buildAgyAccountRow(_ account: AgyAccountDto, disabled: Bool) -> NSView {
        let wrapper = UI.vstack(spacing: 5)
        let row = UI.hstack(spacing: 8)

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3.5
        dot.layer?.backgroundColor = (account.active ? NSColor.systemGreen : NSColor.tertiaryLabelColor.withAlphaComponent(0.45)).cgColor
        dot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 7),
            dot.heightAnchor.constraint(equalToConstant: 7),
        ])
        row.addArrangedSubview(dot)

        let infoCol = UI.vstack(spacing: 1)
        infoCol.addArrangedSubview(UI.label(account.alias, size: 12.5, weight: account.active ? .semibold : .medium, compressible: true))
        if let email = account.email, !email.isEmpty,
           email.caseInsensitiveCompare(account.alias) != .orderedSame {
            infoCol.addArrangedSubview(UI.label(email, size: 10.5, color: .secondaryLabelColor, compressible: true))
        }
        row.addArrangedSubview(infoCol)
        row.addArrangedSubview(UI.spacer())

        if account.active {
            row.addArrangedSubview(UI.pillBadge(
                "当前",
                textColor: .systemGreen,
                bgColor: NSColor.systemGreen.withAlphaComponent(0.14),
                borderColor: NSColor.systemGreen.withAlphaComponent(0.28)
            ))
        } else {
            let targetId = account.id
            let targetAlias = account.alias
            let switchBtn = GlassPillButton(title: "切换", tone: .accent, compact: true) { [weak self] in
                self?.agyInlineMode = .none
                self?.store.switchAgyAccount(targetId: targetId, targetAlias: targetAlias, force: false)
            }
            switchBtn.isEnabled = !disabled
            row.addArrangedSubview(switchBtn)
        }

        let moreBtn = GlassPillButton(title: "⋯", tone: .neutral, compact: true)
        moreBtn.target = self
        moreBtn.action = #selector(onAgyMoreClicked(_:))
        moreBtn.isEnabled = !disabled
        moreBtn.identifier = NSUserInterfaceItemIdentifier(account.id)
        moreBtn.toolTip = "重命名或删除"
        row.addArrangedSubview(moreBtn)

        wrapper.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: wrapper.widthAnchor).isActive = true

        // For non-active accounts, display the read-only local cached quota snapshot (zero extra network/keychain calls).
        if !account.active {
            let snapshotRow = buildAgyCachedSnapshotLine(account.quota)
            wrapper.addArrangedSubview(snapshotRow)
            snapshotRow.widthAnchor.constraint(equalTo: wrapper.widthAnchor).isActive = true
        }

        return wrapper
    }

    private func compactAgyPoolLabel(_ label: String) -> String {
        label
            .replacingOccurrences(of: "Claude/GPT", with: "Claude")
            .replacingOccurrences(of: "Gemini 4 Argon", with: "Argon")
            .replacingOccurrences(of: " 5 小时", with: " 5h")
            .replacingOccurrences(of: " 每周", with: " 周")
    }

    private func buildAgyCachedSnapshotLine(_ quota: AgyCachedQuotaDto?, now: Date = Date()) -> NSView {
        let strip = UI.hstack(spacing: 5)
        let indent = NSView()
        indent.translatesAutoresizingMaskIntoConstraints = false
        indent.widthAnchor.constraint(equalToConstant: 10).isActive = true
        strip.addArrangedSubview(indent)

        guard let quota = quota, !quota.windows.isEmpty else {
            strip.addArrangedSubview(UI.label("暂无额度快照 · 切过去查一次后自动记录", size: 10.5, color: .tertiaryLabelColor, compressible: true))
            return strip
        }

        // Pick up to 3 representative windows (prioritizing reset-passed exhausted or lowest remaining per family).
        let representative = selectRepresentativeAgyWindows(quota.windows)
        var parts: [String] = []
        var anyRecoveredReset = false
        var lowestActiveRemaining: Double = 100

        for win in representative {
            let shortName = compactAgyPoolLabel(win.label)
            if win.isResetNow && (win.usedPercent ?? 0) > 0 {
                anyRecoveredReset = true
                parts.append("\(shortName) 已到重置点")
            } else if let rem = win.remainingPercent {
                lowestActiveRemaining = min(lowestActiveRemaining, rem)
                let remInt = Int(rem.rounded())
                if remInt <= 25, let resetDate = win.resetsAtDate, resetDate > now {
                    let cd = Formatters.formatRelativeCountdown(to: resetDate, now: now).replacingOccurrences(of: " 后", with: "")
                    parts.append("\(shortName) \(remInt)% (\(cd)重置)")
                } else {
                    parts.append("\(shortName) \(remInt)%")
                }
            } else {
                parts.append("\(shortName) 未知")
            }
        }

        let summaryColor: NSColor
        if lowestActiveRemaining <= 15 {
            summaryColor = .systemRed
        } else if lowestActiveRemaining <= 35 {
            summaryColor = .systemOrange
        } else if anyRecoveredReset {
            summaryColor = .systemGreen
        } else {
            summaryColor = .secondaryLabelColor
        }

        let timePrefix = quota.updatedAtDate.map {
            "快照 \(Formatters.formatWhen($0, now: now).replacingOccurrences(of: "今天 ", with: ""))"
        } ?? "上次快照"
        let summaryLabel = UI.label(
            "\(timePrefix) · \(parts.joined(separator: " · "))",
            size: 10.5,
            weight: anyRecoveredReset ? .medium : .regular,
            color: summaryColor,
            monospacedDigits: true,
            compressible: true
        )

        var tooltipLines: [String] = [
            quota.updatedAtDate.map { "缓存快照更新于：\(Formatters.formatWhen($0, now: now))" } ?? "本机缓存快照"
        ]
        for win in quota.windows {
            if win.isResetNow && (win.usedPercent ?? 0) > 0 {
                let prev = win.remainingPercent.map { "上次剩余 \(Int($0.rounded()))%" } ?? "上次已用"
                tooltipLines.append("• \(win.label)：已到重置点（\(prev)）")
            } else if let rem = win.remainingPercent {
                let resetStr = win.resetsAtDate.map { " · 重置 \(Formatters.formatWhen($0, now: now))" } ?? ""
                tooltipLines.append("• \(win.label)：剩余 \(Int(rem.rounded()))%\(resetStr)")
            } else {
                tooltipLines.append("• \(win.label)：未知")
            }
        }
        summaryLabel.toolTip = tooltipLines.joined(separator: "\n")
        strip.addArrangedSubview(summaryLabel)
        return strip
    }

    private func selectRepresentativeAgyWindows(_ windows: [AgyCachedWindowDto]) -> [AgyCachedWindowDto] {
        var byFamily: [String: [AgyCachedWindowDto]] = [:]
        var familyOrder: [String] = []
        for win in windows {
            let family: String
            if win.label.hasPrefix("Claude") { family = "Claude" }
            else if win.label.contains("Argon") { family = "Argon" }
            else if win.label.hasPrefix("Gemini") { family = "Gemini" }
            else { family = win.label }
            if byFamily[family] == nil { familyOrder.append(family) }
            byFamily[family, default: []].append(win)
        }
        var picked: [AgyCachedWindowDto] = []
        for family in familyOrder.prefix(3) {
            guard let group = byFamily[family], !group.isEmpty else { continue }
            // Prefer a window with active pressure (lowest remaining that hasn't reset), else a reset-passed used window, else first.
            let best = group.min { lhs, rhs in
                let lScore = windowUrgencyScore(lhs)
                let rScore = windowUrgencyScore(rhs)
                return lScore < rScore
            } ?? group[0]
            picked.append(best)
        }
        return picked
    }

    private func windowUrgencyScore(_ win: AgyCachedWindowDto) -> Double {
        if win.isResetNow {
            if let used = win.usedPercent, used >= 50 { return 30 }
            if let used = win.usedPercent, used > 0 { return 105 }
            return 120
        }
        return win.remainingPercent ?? 200
    }

    private func buildThreePeriodGrid(
        today: (usd: Double, tokens: Int64, priced: Int64, unpriced: Int64, incomplete: Bool),
        days7: (usd: Double, tokens: Int64, priced: Int64, unpriced: Int64, incomplete: Bool),
        days30: (usd: Double, tokens: Int64, priced: Int64, unpriced: Int64, incomplete: Bool)
    ) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.distribution = .fillEqually
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false

        for (periodTitle, bucket) in [("今日", today), ("近 7 天", days7), ("近 30 天", days30)] {
            let usdText = Formatters.formatUSD(bucket.usd, pricedTokens: bucket.priced, unpricedTokens: bucket.unpriced, incomplete: bucket.incomplete)
            let tokText = Formatters.formatTokens(bucket.tokens)

            let col = UI.vstack(spacing: 2)
            col.addArrangedSubview(UI.label(periodTitle, size: 10.5, color: .tertiaryLabelColor))
            // If tokens exist but model has no public USD price (e.g. internal agy model), highlight Token count instead of "—"
            if usdText == "—" && bucket.tokens > 0 {
                col.addArrangedSubview(UI.label(tokText, size: 15, weight: .bold, color: .labelColor, rounded: true))
                col.addArrangedSubview(UI.label("未公开单价", size: 10.5, color: .secondaryLabelColor))
            } else {
                col.addArrangedSubview(UI.label(usdText, size: 15, weight: .bold, color: .labelColor, rounded: true))
                col.addArrangedSubview(UI.label("\(tokText) tok", size: 11, color: .secondaryLabelColor, monospacedDigits: true))
            }
            row.addArrangedSubview(col)
        }
        return row
    }

    // MARK: - Settings Tab (macOS Liquid Glass Grouped Inset Cards with NSSwitch)
    private func buildSettingsBody(into stack: NSStackView) {
        // 1. Menu Bar & Cadence Card
        let (barCard, barStack) = UI.cardContainer(padding: 11, spacing: 8)

        let styleRow = UI.hstack(spacing: 8)
        styleRow.addArrangedSubview(UI.label("菜单栏显示", size: 12.5, weight: .medium))
        styleRow.addArrangedSubview(UI.spacer())
        let stylePopup = NSPopUpButton(frame: .zero, pullsDown: false)
        stylePopup.controlSize = .small
        stylePopup.font = NSFont.systemFont(ofSize: 12)
        stylePopup.translatesAutoresizingMaskIntoConstraints = false
        for style in MenuBarDisplayStyle.allCases {
            stylePopup.addItem(withTitle: style.title)
        }
        if let idx = MenuBarDisplayStyle.allCases.firstIndex(of: store.menuBarStyle) {
            stylePopup.selectItem(at: idx)
        }
        stylePopup.target = self
        stylePopup.action = #selector(onMenuBarStyleChanged(_:))
        styleRow.addArrangedSubview(stylePopup)
        barStack.addArrangedSubview(styleRow)
        styleRow.widthAnchor.constraint(equalTo: barStack.widthAnchor).isActive = true

        let div1 = UI.hairline(vertical: false)
        barStack.addArrangedSubview(div1)
        div1.widthAnchor.constraint(equalTo: barStack.widthAnchor).isActive = true

        let intRow = UI.hstack(spacing: 8)
        intRow.addArrangedSubview(UI.label("刷新频率", size: 12.5, weight: .medium))
        intRow.addArrangedSubview(UI.spacer())
        let intPopup = NSPopUpButton(frame: .zero, pullsDown: false)
        intPopup.controlSize = .small
        intPopup.font = NSFont.systemFont(ofSize: 12)
        intPopup.translatesAutoresizingMaskIntoConstraints = false
        let intervals = [(60, "每 1 分钟"), (300, "每 5 分钟 (推荐)"), (600, "每 10 分钟"), (900, "每 15 分钟")]
        for (sec, title) in intervals {
            intPopup.addItem(withTitle: title)
            intPopup.lastItem?.tag = sec
        }
        intPopup.selectItem(at: intervals.firstIndex(where: { $0.0 == store.refreshIntervalSeconds }) ?? 1)
        intPopup.target = self
        intPopup.action = #selector(onIntervalChanged(_:))
        intRow.addArrangedSubview(intPopup)
        barStack.addArrangedSubview(intRow)
        intRow.widthAnchor.constraint(equalTo: barStack.widthAnchor).isActive = true

        stack.addArrangedSubview(barCard)
        barCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        // 2. Enabled Services Card with Brand Badges & Pill Switches
        let (provCard, provStack) = UI.cardContainer(padding: 11, spacing: 7)
        provStack.addArrangedSubview(UI.label("显示的服务商", size: 11.5, weight: .semibold, color: .secondaryLabelColor))
        for (idx, name) in UsageStore.allProviders.enumerated() {
            if idx > 0 {
                let d = UI.hairline(vertical: false)
                provStack.addArrangedSubview(d)
                d.widthAnchor.constraint(equalTo: provStack.widthAnchor).isActive = true
            }
            let row = UI.hstack(spacing: 8)
            row.addArrangedSubview(BrandBadgeView(provider: name, size: 22))
            row.addArrangedSubview(UI.label(name, size: 12.5, weight: .medium))
            if !store.isProviderLoggedInOrActive(name) {
                row.addArrangedSubview(UI.pillBadge("未登录 · 已自动隐藏", textColor: .tertiaryLabelColor))
            }
            row.addArrangedSubview(UI.spacer())
            let sw = NSSwitch()
            sw.controlSize = .small
            sw.identifier = NSUserInterfaceItemIdentifier(name)
            sw.state = store.isProviderEnabled(name) ? .on : .off
            sw.target = self
            sw.action = #selector(onProviderToggle(_:))
            row.addArrangedSubview(sw)
            provStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: provStack.widthAnchor).isActive = true
        }
        stack.addArrangedSubview(provCard)
        provCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        // 3. System & Modes Card
        let (modeCard, modeStack) = UI.cardContainer(padding: 11, spacing: 7)
        let r1 = UI.settingToggleRow(title: "开机自动启动", subtitle: "登录 macOS 时自动驻留顶部状态栏", isOn: store.launchAtLogin, target: self, action: #selector(onLaunchAtLoginChanged(_:)))
        modeStack.addArrangedSubview(r1)
        r1.widthAnchor.constraint(equalTo: modeStack.widthAnchor).isActive = true

        let dm1 = UI.hairline(vertical: false); modeStack.addArrangedSubview(dm1); dm1.widthAnchor.constraint(equalTo: modeStack.widthAnchor).isActive = true
        let r2 = UI.settingToggleRow(title: "离线只读模式", subtitle: "仅读取本机日志与本地缓存，不发网络请求", isOn: store.isOfflineMode, target: self, action: #selector(onOfflineChanged(_:)))
        modeStack.addArrangedSubview(r2)
        r2.widthAnchor.constraint(equalTo: modeStack.widthAnchor).isActive = true

        let dm2 = UI.hairline(vertical: false); modeStack.addArrangedSubview(dm2); dm2.widthAnchor.constraint(equalTo: modeStack.widthAnchor).isActive = true
        let r3 = UI.settingToggleRow(title: "示例数据预览", subtitle: "使用内置演示数据查看界面效果", isOn: store.isDemoMode, target: self, action: #selector(onDemoChanged(_:)))
        modeStack.addArrangedSubview(r3)
        r3.widthAnchor.constraint(equalTo: modeStack.widthAnchor).isActive = true

        stack.addArrangedSubview(modeCard)
        modeCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        // 3.5 agy Switching Automation Card
        let (agyCard, agyStack) = UI.cardContainer(padding: 11, spacing: 7)
        agyStack.addArrangedSubview(UI.label("agy 切号自动化", size: 11.5, weight: .semibold, color: .secondaryLabelColor))
        let g1 = UI.settingToggleRow(
            title: "防旧进程覆写钥匙串",
            subtitle: "旧终端 agy 刷新令牌时自动保存其新票据，并保持当前切换的目标号生效",
            isOn: store.agyAutoGuardEnabled,
            target: self,
            action: #selector(onAgyAutoGuardChanged(_:))
        )
        agyStack.addArrangedSubview(g1)
        g1.widthAnchor.constraint(equalTo: agyStack.widthAnchor).isActive = true

        let dg1 = UI.hairline(vertical: false); agyStack.addArrangedSubview(dg1); dg1.widthAnchor.constraint(equalTo: agyStack.widthAnchor).isActive = true
        let g2 = UI.settingToggleRow(
            title: "切号时自动关闭旧 agy",
            subtitle: "点击「切换」时仅温和退出切号前的旧账号 agy，不会影响切号后新开的窗口",
            isOn: store.closeRunningAgyOnSwitch,
            target: self,
            action: #selector(onAgyCloseOnSwitchChanged(_:))
        )
        agyStack.addArrangedSubview(g2)
        g2.widthAnchor.constraint(equalTo: agyStack.widthAnchor).isActive = true

        stack.addArrangedSubview(agyCard)
        agyCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        // 4. Bottom Action Row
        let btnRow = UI.hstack(spacing: 8)
        let openCacheBtn = GlassPillButton(title: "打开缓存文件夹", tone: .neutral, compact: false) { [weak self] in
            self?.onOpenCacheDir()
        }
        btnRow.addArrangedSubview(openCacheBtn)
        btnRow.addArrangedSubview(UI.spacer())

        let quitBtn = GlassPillButton(title: "退出 AIUsage", tone: .destructive, compact: false) { [weak self] in
            self?.onQuitApp()
        }
        btnRow.addArrangedSubview(quitBtn)

        stack.addArrangedSubview(btnRow)
        btnRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    // MARK: - Actions
    @objc private func onMenuBarStyleChanged(_ sender: NSPopUpButton) {
        let idx = sender.indexOfSelectedItem
        guard MenuBarDisplayStyle.allCases.indices.contains(idx) else { return }
        store.menuBarStyle = MenuBarDisplayStyle.allCases[idx]
    }

    @objc private func onProviderToggle(_ sender: NSSwitch) {
        guard let name = sender.identifier?.rawValue else { return }
        store.setProviderEnabled(name, enabled: sender.state == .on)
        render()
    }

    @objc private func onIntervalChanged(_ sender: NSPopUpButton) {
        guard let tag = sender.selectedItem?.tag, tag > 0 else { return }
        store.refreshIntervalSeconds = tag
    }

    @objc private func onLaunchAtLoginChanged(_ sender: NSSwitch) {
        store.launchAtLogin = (sender.state == .on)
        render()
    }

    @objc private func onOfflineChanged(_ sender: NSSwitch) {
        store.isOfflineMode = (sender.state == .on)
    }

    @objc private func onDemoChanged(_ sender: NSSwitch) {
        store.isDemoMode = (sender.state == .on)
    }

    @objc private func onAgyAutoGuardChanged(_ sender: NSSwitch) {
        store.setAgyAutoGuard(enabled: sender.state == .on)
    }

    @objc private func onAgyCloseOnSwitchChanged(_ sender: NSSwitch) {
        store.closeRunningAgyOnSwitch = (sender.state == .on)
    }

    @objc private func onOpenCacheDir() {
        let cacheURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/aiusage")
        try? FileManager.default.createDirectory(at: cacheURL, withIntermediateDirectories: true)
        NSWorkspace.shared.open(cacheURL)
    }

    @objc private func onAgyStartSave() {
        // One-click save without forcing a custom nickname (defaults to account email; rename anytime via ⋯).
        agyInlineMode = .none
        activeInlineTextField = nil
        store.saveCurrentAgyAccount(alias: nil)
    }

    @objc private func onAgyPrepareLogout() {
        agyInlineMode = .none
        store.prepareNewAgyLogin(force: false)
    }

    @objc private func onAgySwitchClicked(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        let alias = store.agyAccounts?.accounts.first(where: { $0.id == id })?.alias ?? id
        agyInlineMode = .none
        store.switchAgyAccount(targetId: id, targetAlias: alias, force: false)
    }

    @objc private func onAgyMoreClicked(_ sender: NSControl) {
        guard let id = sender.identifier?.rawValue,
              let account = store.agyAccounts?.accounts.first(where: { $0.id == id }) else { return }
        let menu = NSMenu()
        let renameItem = NSMenuItem(title: "重命名…", action: #selector(onAgyMenuRename(_:)), keyEquivalent: "")
        renameItem.target = self
        renameItem.representedObject = account
        menu.addItem(renameItem)

        let removeItem = NSMenuItem(title: "删除已保存票据", action: #selector(onAgyMenuDelete(_:)), keyEquivalent: "")
        removeItem.target = self
        removeItem.representedObject = account
        menu.addItem(removeItem)

        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 2), in: sender)
    }

    @objc private func onAgyMenuRename(_ sender: NSMenuItem) {
        guard let account = sender.representedObject as? AgyAccountDto else { return }
        agyInlineMode = .rename(id: account.id, currentAlias: account.alias)
        DispatchQueue.main.async { [weak self] in
            self?.render()
        }
    }

    @objc private func onAgyMenuDelete(_ sender: NSMenuItem) {
        guard let account = sender.representedObject as? AgyAccountDto else { return }
        agyInlineMode = .confirmDelete(id: account.id, alias: account.alias)
        DispatchQueue.main.async { [weak self] in
            self?.render()
        }
    }

    @objc private func onAgyInlineSubmit() {
        let value = activeInlineTextField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let mode = agyInlineMode
        agyInlineMode = .none
        activeInlineTextField = nil
        switch mode {
        case .saveNew:
            store.saveCurrentAgyAccount(alias: value.isEmpty ? nil : value)
        case .rename(let id, _):
            let hasEmail = store.agyAccounts?.accounts.first(where: { $0.id == id })?.email != nil
            if !value.isEmpty || hasEmail {
                store.renameAgyAccount(targetId: id, newAlias: value)
            } else {
                render()
            }
        case .confirmDelete, .none:
            render()
        }
    }

    @objc private func onAgyConfirmDelete() {
        if case .confirmDelete(let id, _) = agyInlineMode {
            agyInlineMode = .none
            store.removeAgyAccount(targetId: id)
        }
    }

    @objc private func onAgyInlineCancel() {
        agyInlineMode = .none
        activeInlineTextField = nil
        render()
    }

    @objc private func onAgyResolveConflictForce() {
        guard let conflict = store.agyConflict else { return }
        switch conflict {
        case .unsavedSwitch(let targetId, let targetAlias):
            store.switchAgyAccount(targetId: targetId, targetAlias: targetAlias, force: true)
        case .unsavedLogout:
            store.prepareNewAgyLogin(force: true)
        }
    }

    @objc private func onAgyDismissConflict() {
        store.clearAgyConflict()
    }

    @objc private func onAgyDismissNotice() {
        store.clearAgyNotice()
    }

    @objc private func onQuitApp() {
        NSApp.terminate(nil)
    }

    // MARK: - Footer
    private func updateFooter() {
        guard let s = session else { return }
        if store.isRefreshing {
            s.footerLeftLabel.stringValue = "正在同步…"
            s.footerLeftLabel.textColor = .secondaryLabelColor
        } else if let err = store.lastError {
            s.footerLeftLabel.stringValue = err
            s.footerLeftLabel.textColor = .systemOrange
        } else if let updated = store.quotaUpdatedAt(for: selectedTab) ?? store.lastUpdatedAt {
            s.footerLeftLabel.stringValue = "更新于 \(Formatters.formatWhen(updated).replacingOccurrences(of: "今天 ", with: ""))"
            s.footerLeftLabel.textColor = .secondaryLabelColor
        } else {
            s.footerLeftLabel.stringValue = "准备就绪"
            s.footerLeftLabel.textColor = .secondaryLabelColor
        }

        if store.isDemoMode {
            s.footerRightLabel.stringValue = "示例预览"
        } else if store.isOfflineMode {
            s.footerRightLabel.stringValue = "离线只读"
        } else if let next = store.nextQuotaRefreshDate(for: selectedTab) {
            s.footerRightLabel.stringValue = "下次远程刷新 \(Formatters.formatRelativeCountdown(to: next))"
        } else {
            s.footerRightLabel.stringValue = ""
        }
    }
}
