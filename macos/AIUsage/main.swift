import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = UsageStore()
    private var statusItem: NSStatusItem!
    private var panelController: PanelController!
    private var lastMenuBarSignature: String?
    private var lastMenuBarToolTip: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        panelController = PanelController(store: store)
        store.isPanelVisible = { [weak self] in
            self?.panelController.isVisible ?? false
        }

        if let button = statusItem.button {
            button.image = BrandIcons.menuBarIcon()
            button.imagePosition = .imageOnly
            button.target = self
            button.action = #selector(onStatusBarClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        store.onChange = { [weak self] in
            guard let self = self else { return }
            self.updateStatusItem()
            self.panelController.refreshIfVisible()
            if self.store.agyConflict != nil, !self.panelController.isVisible {
                self.panelController.showProvider("agy", relativeTo: self.statusItem.button)
            }
        }

        updateStatusItem()
        store.start()
    }

    @objc private func onStatusBarClicked(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        let isRightClick = event?.type == .rightMouseUp || (event?.modifierFlags.contains(.control) == true)
        if isRightClick {
            panelController.hide()
            showContextMenu()
        } else {
            panelController.toggle(relativeTo: statusItem.button)
        }
    }

    private func showContextMenu() {
        let menu = NSMenu()
        let refreshItem = NSMenuItem(title: store.isRefreshing ? "正在刷新…" : "立即刷新", action: #selector(onMenuRefresh), keyEquivalent: "r")
        refreshItem.target = self
        refreshItem.isEnabled = !store.isRefreshing
        menu.addItem(refreshItem)

        if let agyInfo = store.agyAccounts, agyInfo.supported {
            let agyMenu = NSMenu()
            if agyInfo.accounts.isEmpty {
                let emptyItem = NSMenuItem(title: "尚未保存 agy 账号", action: nil, keyEquivalent: "")
                emptyItem.isEnabled = false
                agyMenu.addItem(emptyItem)
            } else {
                for account in agyInfo.accounts {
                    let showEmail = account.email.map { $0.caseInsensitiveCompare(account.alias) != .orderedSame } ?? false
                    var title = showEmail ? "\(account.alias) (\(account.email!))" : account.alias
                    if !account.active, let wins = account.quota?.windows, !wins.isEmpty {
                        let activeLow = wins.filter({ !$0.isResetNow }).compactMap(\.remainingPercent).min()
                        let hasRecovered = wins.contains(where: { $0.isResetNow && ($0.usedPercent ?? 0) >= 50 })
                        if let low = activeLow, low <= 25 {
                            title += " · 最低剩余 \(Int(low.rounded()))%"
                        } else if hasRecovered {
                            title += " · 已到重置点"
                        } else if let low = activeLow {
                            title += " · 最低剩余 \(Int(low.rounded()))%"
                        }
                    }
                    let item = NSMenuItem(title: title, action: #selector(onMenuSwitchAgyAccount(_:)), keyEquivalent: "")
                    item.target = self
                    item.state = account.active ? .on : .off
                    item.representedObject = account
                    item.isEnabled = !store.isAgyAccountBusy
                    agyMenu.addItem(item)
                }
            }
            agyMenu.addItem(NSMenuItem.separator())
            let manageItem = NSMenuItem(title: "管理 agy 账号…", action: #selector(onMenuOpenAgyTab), keyEquivalent: "")
            manageItem.target = self
            agyMenu.addItem(manageItem)

            let agySub = NSMenuItem(title: "切换 agy 账号", action: nil, keyEquivalent: "")
            agySub.submenu = agyMenu
            menu.addItem(agySub)
        }

        let demoItem = NSMenuItem(title: "示例数据预览", action: #selector(onMenuToggleDemo), keyEquivalent: "")
        demoItem.target = self
        demoItem.state = store.isDemoMode ? .on : .off
        menu.addItem(demoItem)

        let settingsItem = NSMenuItem(title: "设置…", action: #selector(onMenuOpenSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "退出 AIUsage", action: #selector(onMenuQuit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func onMenuRefresh() {
        store.triggerRefresh(offlineOnly: store.isOfflineMode, forceRemote: !store.isOfflineMode)
    }

    @objc private func onMenuSwitchAgyAccount(_ sender: NSMenuItem) {
        guard let account = sender.representedObject as? AgyAccountDto else { return }
        store.switchAgyAccount(targetId: account.id, targetAlias: account.alias, force: false)
    }

    @objc private func onMenuOpenAgyTab() {
        panelController.showProvider("agy", relativeTo: statusItem.button)
    }

    @objc private func onMenuToggleDemo() {
        store.isDemoMode.toggle()
    }

    @objc private func onMenuOpenSettings() {
        panelController.showSettings(relativeTo: statusItem.button)
    }

    @objc private func onMenuQuit() {
        NSApp.terminate(nil)
    }

    private func updateStatusItem() {
        guard let button = statusItem.button else { return }

        let signature: String
        var stripItems: [(provider: String?, text: String)]? = nil

        switch store.menuBarStyle {
        case .iconOnly:
            signature = "icon"

        case .urgentRemaining:
            if let urgent = store.mostUrgentWindow {
                let remInt = Int(urgent.remainingPercent.rounded())
                signature = "urgent|\(urgent.provider):\(remInt)%"
                stripItems = [(provider: urgent.provider, text: "\(remInt)%")]
            } else {
                signature = "icon"
            }

        case .todayCost:
            let today = store.filteredTodayCost
            let formatted = Formatters.formatUSD(today.usd, pricedTokens: today.priced, unpricedTokens: today.unpriced, incomplete: today.incomplete)
            signature = "cost|\(formatted)"
            stripItems = [(provider: nil, text: formatted)]

        case .multiCompact:
            var items: [(provider: String?, text: String)] = []
            for p in store.visibleProviders where !p.skipped {
                if let maxUsed = p.windows.compactMap(\.usedPercent).max() {
                    let rem = Int(max(0, 100 - maxUsed).rounded())
                    items.append((provider: p.name, text: "\(rem)%"))
                }
            }
            if items.isEmpty {
                signature = "icon"
            } else {
                signature = "multi|" + items.map { "\($0.provider ?? ""):\($0.text)" }.joined(separator: ",")
                stripItems = items
            }
        }

        if signature != lastMenuBarSignature {
            lastMenuBarSignature = signature
            button.attributedTitle = NSAttributedString(string: "")
            button.imagePosition = .imageOnly
            if let items = stripItems {
                button.image = BrandIcons.compositeMenuBarStrip(items: items)
            } else {
                button.image = BrandIcons.menuBarIcon()
            }
        }

        // Rich hover tooltip with full overview
        var tipLines = ["AIUsage"]
        for p in store.visibleProviders where !p.skipped {
            if let w = p.windows.max(by: { ($0.usedPercent ?? -1) < ($1.usedPercent ?? -1) }),
               let rem = w.remainingPercent {
                tipLines.append("\(p.name) · \(w.label): 剩余 \(Int(rem.rounded()))%")
            }
        }
        let today = store.filteredTodayCost
        if today.usd > 0 || today.priced > 0 {
            tipLines.append("今日等价 API: \(Formatters.formatUSD(today.usd, pricedTokens: today.priced, unpricedTokens: today.unpriced, incomplete: today.incomplete))")
        }
        let tip = tipLines.joined(separator: "\n")
        if tip != lastMenuBarToolTip {
            lastMenuBarToolTip = tip
            button.toolTip = tip
        }
    }
}

if CommandLine.arguments.contains("--self-test") {
    let exitCode: Int32 = MainActor.assumeIsolated {
        let store = UsageStore()
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let decoded = try? JSONDecoder().decode(AIUsagePayload.self, from: data),
              decoded.providers.count == 4 else {
            fputs("SELF-TEST FAIL: invalid JSON payload\n", stderr)
            return 1
        }
        store.injectPayloadForTest(decoded)
        let now = Date()
        store.injectAgyAccountsForTest(AgyAccountsPayload(
            activeId: "agy_demo_1",
            previousId: "agy_demo_2",
            accounts: [
                AgyAccountDto(id: "agy_demo_1", alias: "主号", email: "main@example.com", active: true),
                AgyAccountDto(
                    id: "agy_demo_2",
                    alias: "副号",
                    email: "backup@example.com",
                    active: false,
                    quota: AgyCachedQuotaDto(
                        updatedAtDate: now.addingTimeInterval(-7200),
                        windows: [
                            AgyCachedWindowDto(label: "Gemini 5 小时", usedPercent: 100, remainingPercent: 0, resetsAtDate: now.addingTimeInterval(-600), resetPassed: true),
                            AgyCachedWindowDto(label: "Gemini 每周", usedPercent: 30, remainingPercent: 70, resetsAtDate: now.addingTimeInterval(3 * 86400), resetPassed: false),
                            AgyCachedWindowDto(label: "Claude/GPT 5 小时", usedPercent: 0, remainingPercent: 100, resetsAtDate: now.addingTimeInterval(4 * 3600), resetPassed: false),
                        ]
                    )
                ),
            ]
        ))
        let panel = PanelController(store: store)
        for tab: NavigationTab in [.overview, .provider("Claude"), .provider("Codex"), .provider("Grok"), .provider("agy"), .settings] {
            panel.selectTabAndLayout(tab)
        }
        let strip = BrandIcons.compositeMenuBarStrip(items: [
            (provider: "Claude", text: "46%"),
            (provider: "Codex", text: "22%"),
            (provider: "Grok", text: "84%"),
            (provider: "agy", text: "79%"),
        ])
        guard strip.size.width > 80 else {
            fputs("SELF-TEST FAIL: composite menu bar strip invalid\n", stderr)
            return 1
        }
        let opusShort = Formatters.shortModel("claude-opus-5-5")
        let geminiShort = Formatters.shortModel("gemini-4-carbon-high")
        guard opusShort == "Opus 5.5", geminiShort == "Gemini 4 Carbon High" else {
            fputs("SELF-TEST FAIL: model formatting mismatch (\(opusShort), \(geminiShort))\n", stderr)
            return 1
        }
        if let dumpIdx = CommandLine.arguments.firstIndex(of: "--dump-preview"),
           CommandLine.arguments.indices.contains(dumpIdx + 1) {
            let outDir = URL(fileURLWithPath: CommandLine.arguments[dumpIdx + 1])
            try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
            let lightApp = NSAppearance(named: .aqua)
            let darkApp = NSAppearance(named: .darkAqua)
            for (name, tab) in [("overview", NavigationTab.overview), ("agy", .provider("agy")), ("claude", .provider("Claude")), ("settings", .settings)] {
                panel.selectTabAndLayout(tab)
                if let png = panel.snapshotPNG(appearance: lightApp) {
                    try? png.write(to: outDir.appendingPathComponent("\(name)-light.png"))
                }
                if let png = panel.snapshotPNG(appearance: darkApp) {
                    try? png.write(to: outDir.appendingPathComponent("\(name)-dark.png"))
                }
            }
            if let tiff = strip.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let barPng = rep.representation(using: .png, properties: [:]) {
                try? barPng.write(to: outDir.appendingPathComponent("menubar.png"))
            }
        }
        print("SELF-TEST PASS: \(decoded.providers.count) providers decoded and 6 tabs laid out")
        return 0
    }
    exit(exitCode)
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.run()
