import AppKit

// MARK: - macOS Liquid Glass Theme (Light & Dark Vibrancy-First Palette)
enum Theme {
    static func isDark(_ view: NSView? = nil) -> Bool {
        let appearance = view?.effectiveAppearance ?? NSApp.effectiveAppearance
        return appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }

    static func canvasVeil(_ dark: Bool) -> NSColor {
        dark
            ? NSColor(srgbRed: 0.065, green: 0.072, blue: 0.105, alpha: 0.56)
            : NSColor(srgbRed: 0.975, green: 0.984, blue: 1.000, alpha: 0.22)
    }

    static func sidebarVeil(_ dark: Bool) -> NSColor {
        dark
            ? NSColor(srgbRed: 0.035, green: 0.040, blue: 0.065, alpha: 0.34)
            : NSColor(white: 1.0, alpha: 0.18)
    }

    static func cardBg(_ dark: Bool, hovered: Bool = false) -> NSColor {
        if dark {
            return hovered
                ? NSColor(srgbRed: 0.19, green: 0.21, blue: 0.28, alpha: 0.62)
                : NSColor(srgbRed: 0.13, green: 0.145, blue: 0.20, alpha: 0.52)
        } else {
            return hovered
                ? NSColor(white: 1.0, alpha: 0.78)
                : NSColor(white: 1.0, alpha: 0.58)
        }
    }

    static func cardSheenTop(_ dark: Bool) -> NSColor {
        dark
            ? NSColor(white: 1.0, alpha: 0.085)
            : NSColor(white: 1.0, alpha: 0.52)
    }

    static func rimTop(_ dark: Bool) -> NSColor {
        dark
            ? NSColor(white: 1.0, alpha: 0.24)
            : NSColor(white: 1.0, alpha: 0.92)
    }

    static func rimBottom(_ dark: Bool) -> NSColor {
        dark
            ? NSColor(white: 1.0, alpha: 0.06)
            : NSColor(srgbRed: 0.45, green: 0.52, blue: 0.64, alpha: 0.16)
    }

    static func hairlineColor(_ dark: Bool) -> NSColor {
        dark
            ? NSColor(white: 1.0, alpha: 0.09)
            : NSColor(srgbRed: 0.15, green: 0.20, blue: 0.30, alpha: 0.08)
    }

    static func trackBg(_ dark: Bool) -> NSColor {
        dark
            ? NSColor(white: 1.0, alpha: 0.11)
            : NSColor(srgbRed: 0.10, green: 0.14, blue: 0.24, alpha: 0.085)
    }

    static func barGradientColors(for provider: String?, usedPercent: Double, dark: Bool) -> (NSColor, NSColor) {
        if usedPercent >= 85 {
            return (
                NSColor(srgbRed: 0.96, green: 0.26, blue: 0.36, alpha: 1.0),
                NSColor(srgbRed: 1.00, green: 0.42, blue: 0.34, alpha: 1.0)
            )
        }
        if usedPercent >= 65 {
            return (
                NSColor(srgbRed: 0.96, green: 0.58, blue: 0.07, alpha: 1.0),
                NSColor(srgbRed: 1.00, green: 0.72, blue: 0.22, alpha: 1.0)
            )
        }
        switch provider {
        case "Claude":
            return (
                NSColor(srgbRed: 0.85, green: 0.44, blue: 0.31, alpha: 1.0),
                NSColor(srgbRed: 0.96, green: 0.62, blue: 0.45, alpha: 1.0)
            )
        case "Codex":
            return (
                NSColor(srgbRed: 0.05, green: 0.64, blue: 0.50, alpha: 1.0),
                NSColor(srgbRed: 0.20, green: 0.83, blue: 0.72, alpha: 1.0)
            )
        case "Grok":
            return dark
                ? (
                    NSColor(srgbRed: 0.56, green: 0.62, blue: 0.98, alpha: 1.0),
                    NSColor(srgbRed: 0.78, green: 0.84, blue: 1.00, alpha: 1.0)
                )
                : (
                    NSColor(srgbRed: 0.24, green: 0.28, blue: 0.38, alpha: 1.0),
                    NSColor(srgbRed: 0.42, green: 0.48, blue: 0.64, alpha: 1.0)
                )
        case "agy":
            return (
                NSColor(srgbRed: 0.22, green: 0.51, blue: 0.97, alpha: 1.0),
                NSColor(srgbRed: 0.25, green: 0.76, blue: 0.99, alpha: 1.0)
            )
        default:
            return (
                NSColor.controlAccentColor,
                NSColor.controlAccentColor.blended(withFraction: 0.32, of: .white) ?? NSColor.controlAccentColor
            )
        }
    }

    static func ambientAuraColor(for tab: NavigationTab, dark: Bool) -> NSColor {
        switch tab {
        case .overview:
            return dark
                ? NSColor(srgbRed: 0.28, green: 0.56, blue: 0.98, alpha: 0.16)
                : NSColor(srgbRed: 0.30, green: 0.62, blue: 0.98, alpha: 0.13)
        case .settings:
            return dark
                ? NSColor(srgbRed: 0.56, green: 0.50, blue: 0.96, alpha: 0.14)
                : NSColor(srgbRed: 0.50, green: 0.56, blue: 0.92, alpha: 0.11)
        case .provider(let name):
            let brand = BrandIcons.brandColor(for: name, isDark: dark)
            return brand.withAlphaComponent(dark ? 0.18 : 0.13)
        }
    }

    static func drawGlassRim(in rect: NSRect, radius: CGFloat, topColor: NSColor, bottomColor: NSColor, lineWidth: CGFloat = 1.0) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let inset = rect.insetBy(dx: lineWidth / 2.0, dy: lineWidth / 2.0)
        guard inset.width > 1, inset.height > 1 else { return }
        let path = CGPath(roundedRect: inset, cornerWidth: radius, cornerHeight: radius, transform: nil)
        ctx.saveGState()
        ctx.addPath(path)
        ctx.setLineWidth(lineWidth)
        ctx.replacePathWithStrokedPath()
        ctx.clip()
        if let grad = NSGradient(starting: topColor, ending: bottomColor) {
            grad.draw(in: rect, angle: -90)
        }
        ctx.restoreGState()
    }
}

// MARK: - Exterior-Only Rounded Drop Shadow (Punches Out Glass Interior via Even-Odd Mask)
final class GlassOuterShadowView: NSView {
    let cornerRadius: CGFloat
    let insets: NSEdgeInsets

    private let shadowLayer = CALayer()
    private let cutoutMask = CAShapeLayer()

    init(cornerRadius: CGFloat, insets: NSEdgeInsets) {
        self.cornerRadius = cornerRadius
        self.insets = insets
        super.init(frame: .zero)
        self.translatesAutoresizingMaskIntoConstraints = false
        self.wantsLayer = true
        self.layer?.masksToBounds = false
        self.layer?.backgroundColor = NSColor.clear.cgColor

        shadowLayer.backgroundColor = NSColor.clear.cgColor
        shadowLayer.shadowColor = NSColor.black.cgColor
        shadowLayer.shadowRadius = 15
        shadowLayer.shadowOffset = CGSize(width: 0, height: -5)
        cutoutMask.fillRule = .evenOdd
        shadowLayer.mask = cutoutMask
        self.layer?.addSublayer(shadowLayer)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        updateShadowGeometry()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateShadowGeometry()
    }

    private func updateShadowGeometry() {
        let dark = Theme.isDark(self)
        let glassRect = NSRect(
            x: insets.left,
            y: insets.bottom,
            width: max(0, bounds.width - insets.left - insets.right),
            height: max(0, bounds.height - insets.top - insets.bottom)
        )
        guard glassRect.width > 2, glassRect.height > 2 else { return }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shadowLayer.frame = bounds
        let glassPath = CGPath(roundedRect: glassRect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
        shadowLayer.shadowPath = glassPath
        // Feather-light, airy Apple menu-popover elevation shadow (never heavy or muddy)
        shadowLayer.shadowRadius = dark ? 12 : 9
        shadowLayer.shadowOffset = CGSize(width: 0, height: -3)
        shadowLayer.shadowOpacity = dark ? 0.26 : 0.085

        let maskPath = CGMutablePath()
        maskPath.addRect(bounds.insetBy(dx: -40, dy: -40))
        maskPath.addPath(glassPath)
        cutoutMask.frame = bounds
        cutoutMask.path = maskPath
        CATransaction.commit()
    }
}

// MARK: - Native macOS Liquid Glass Root Window Backdrop (NSGlassEffectView on macOS 26+ / NSVisualEffectView fallback)
@MainActor
enum GlassShellFactory {
    static func makeRootShell(cornerRadius: CGFloat = 20, contentView: NSView) -> (container: NSView, glassView: NSView) {
        if #available(macOS 26.0, *) {
            // Clip NSGlassEffectView strictly to its continuous squircle bounds so its heavy
            // built-in HUD drop shadow doesn't bleed outside; GlassOuterShadowView supplies a
            // subtle, airy menu-bar shadow instead.
            let clipHost = NSView()
            clipHost.translatesAutoresizingMaskIntoConstraints = false
            clipHost.wantsLayer = true
            clipHost.layer?.cornerRadius = cornerRadius
            clipHost.layer?.cornerCurve = .continuous
            clipHost.layer?.masksToBounds = true
            clipHost.layer?.backgroundColor = NSColor.clear.cgColor

            let glass = NSGlassEffectView()
            glass.style = .regular
            glass.cornerRadius = cornerRadius
            glass.translatesAutoresizingMaskIntoConstraints = false
            glass.contentView = contentView

            clipHost.addSubview(glass)
            NSLayoutConstraint.activate([
                glass.leadingAnchor.constraint(equalTo: clipHost.leadingAnchor),
                glass.trailingAnchor.constraint(equalTo: clipHost.trailingAnchor),
                glass.topAnchor.constraint(equalTo: clipHost.topAnchor),
                glass.bottomAnchor.constraint(equalTo: clipHost.bottomAnchor),
            ])
            return (clipHost, glass)
        } else {
            let visual = NSVisualEffectView()
            visual.material = .hudWindow
            visual.blendingMode = .behindWindow
            visual.state = .active
            visual.translatesAutoresizingMaskIntoConstraints = false
            visual.wantsLayer = true
            visual.layer?.cornerRadius = cornerRadius
            visual.layer?.cornerCurve = .continuous
            visual.layer?.masksToBounds = true
            contentView.translatesAutoresizingMaskIntoConstraints = false
            visual.addSubview(contentView)
            NSLayoutConstraint.activate([
                contentView.leadingAnchor.constraint(equalTo: visual.leadingAnchor),
                contentView.trailingAnchor.constraint(equalTo: visual.trailingAnchor),
                contentView.topAnchor.constraint(equalTo: visual.topAnchor),
                contentView.bottomAnchor.constraint(equalTo: visual.bottomAnchor),
            ])
            return (visual, visual)
        }
    }

    static func updateTint(on shell: NSView?, for tab: NavigationTab) {
        guard #available(macOS 26.0, *), let glass = shell as? NSGlassEffectView else { return }
        let dark = Theme.isDark(glass)
        switch tab {
        case .overview, .settings:
            glass.tintColor = nil
        case .provider(let name):
            glass.tintColor = BrandIcons.brandColor(for: name, isDark: dark).withAlphaComponent(dark ? 0.10 : 0.06)
        }
    }
}

// MARK: - Luminous Glass Canvas Overlay (Pure CALayer / CAGradientLayer — Zero Pixel Backing Store)
final class GlassCanvasView: NSView {
    var activeTab: NavigationTab = .overview { didSet { needsDisplay = true } }
    let cornerRadius: CGFloat

    private let topSheenLayer = CAGradientLayer()
    private let auraLayer = CAGradientLayer()
    private let fallbackRimLayer = CALayer()

    init(cornerRadius: CGFloat = 22) {
        self.cornerRadius = cornerRadius
        super.init(frame: .zero)
        self.wantsLayer = true
        self.layerContentsRedrawPolicy = .onSetNeedsDisplay

        topSheenLayer.startPoint = CGPoint(x: 0.5, y: 1.0)
        topSheenLayer.endPoint = CGPoint(x: 0.5, y: 0.0)
        topSheenLayer.zPosition = -2

        auraLayer.type = .radial
        auraLayer.startPoint = CGPoint(x: 0.5, y: 0.5)
        auraLayer.endPoint = CGPoint(x: 1.0, y: 1.0)
        auraLayer.zPosition = -1

        self.layer?.cornerRadius = cornerRadius
        self.layer?.cornerCurve = .continuous
        self.layer?.masksToBounds = true
        self.layer?.addSublayer(topSheenLayer)
        self.layer?.addSublayer(auraLayer)

        if #available(macOS 26.0, *) {
            // Native NSGlassEffectView renders its own optical continuous rim.
        } else {
            fallbackRimLayer.cornerRadius = cornerRadius
            fallbackRimLayer.cornerCurve = .continuous
            fallbackRimLayer.borderWidth = 1.0
            fallbackRimLayer.zPosition = 100
            self.layer?.addSublayer(fallbackRimLayer)
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    override var wantsUpdateLayer: Bool { true }

    override func layout() {
        super.layout()
        updateLayer()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func updateLayer() {
        guard let rootLayer = self.layer else { return }
        let dark = Theme.isDark(self)
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        rootLayer.cornerRadius = cornerRadius
        rootLayer.cornerCurve = .continuous
        rootLayer.masksToBounds = true
        rootLayer.backgroundColor = Theme.canvasVeil(dark).cgColor

        let sheenH = min(96.0, bounds.height)
        topSheenLayer.frame = CGRect(x: 0, y: bounds.height - sheenH, width: bounds.width, height: sheenH)
        topSheenLayer.colors = [
            NSColor(white: 1.0, alpha: dark ? 0.08 : 0.42).cgColor,
            NSColor(white: 1.0, alpha: 0.0).cgColor,
        ]

        let auraColor = Theme.ambientAuraColor(for: activeTab, dark: dark)
        let radius = max(bounds.width, bounds.height) * 0.56
        let cx = bounds.width * 0.78
        let cy = bounds.height * 0.92
        auraLayer.frame = CGRect(x: cx - radius, y: cy - radius, width: radius * 2.0, height: radius * 2.0)
        auraLayer.colors = [
            auraColor.cgColor,
            auraColor.withAlphaComponent(0.0).cgColor,
        ]

        if #available(macOS 26.0, *) {
            // No CPU rim needed
        } else {
            fallbackRimLayer.frame = bounds
            fallbackRimLayer.borderColor = Theme.rimTop(dark).withAlphaComponent(dark ? 0.24 : 0.75).cgColor
        }
        CATransaction.commit()
    }
}

// MARK: - Layered Frosted Glass Surface Container (Zero IOSurface Backing Store)
final class SurfaceView: NSView {
    enum Kind {
        case sidebar
        case card
        case hairline
    }

    let kind: Kind
    let cornerRadius: CGFloat
    var vertical: Bool = false { didSet { needsDisplay = true } }

    private var gradientLayer: CAGradientLayer?

    init(kind: Kind, cornerRadius: CGFloat = 0) {
        self.kind = kind
        self.cornerRadius = cornerRadius
        super.init(frame: .zero)
        self.translatesAutoresizingMaskIntoConstraints = false
        self.wantsLayer = true
        self.layerContentsRedrawPolicy = .onSetNeedsDisplay

        let grad = CAGradientLayer()
        grad.zPosition = -1
        self.layer?.addSublayer(grad)
        self.gradientLayer = grad
    }

    required init?(coder: NSCoder) { fatalError() }

    override var wantsUpdateLayer: Bool { true }

    override func layout() {
        super.layout()
        updateLayer()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func updateLayer() {
        guard let rootLayer = self.layer else { return }
        let dark = Theme.isDark(self)
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        switch kind {
        case .sidebar:
            rootLayer.backgroundColor = Theme.sidebarVeil(dark).cgColor
            rootLayer.cornerRadius = 0
            rootLayer.borderWidth = 0
            if let grad = gradientLayer {
                grad.frame = bounds
                grad.startPoint = CGPoint(x: 0.0, y: 0.5)
                grad.endPoint = CGPoint(x: 1.0, y: 0.5)
                grad.colors = [
                    NSColor(white: 1.0, alpha: dark ? 0.04 : 0.22).cgColor,
                    NSColor(white: 1.0, alpha: 0.0).cgColor,
                ]
                grad.locations = nil
            }

        case .card:
            rootLayer.backgroundColor = Theme.cardBg(dark).cgColor
            rootLayer.cornerRadius = cornerRadius
            rootLayer.cornerCurve = .continuous
            rootLayer.masksToBounds = true
            rootLayer.borderWidth = 1.0
            rootLayer.borderColor = (dark
                ? NSColor(white: 1.0, alpha: 0.14)
                : NSColor(white: 1.0, alpha: 0.78)).cgColor
            if let grad = gradientLayer {
                let topH = min(34.0, bounds.height * 0.45)
                grad.frame = CGRect(x: 0, y: bounds.height - topH, width: bounds.width, height: topH)
                grad.startPoint = CGPoint(x: 0.5, y: 1.0)
                grad.endPoint = CGPoint(x: 0.5, y: 0.0)
                grad.colors = [
                    Theme.cardSheenTop(dark).cgColor,
                    NSColor(white: 1.0, alpha: 0.0).cgColor,
                ]
                grad.locations = nil
            }

        case .hairline:
            rootLayer.backgroundColor = NSColor.clear.cgColor
            rootLayer.cornerRadius = 0
            rootLayer.borderWidth = 0
            if let grad = gradientLayer {
                let c = Theme.hairlineColor(dark)
                grad.frame = bounds
                if vertical {
                    grad.startPoint = CGPoint(x: 0.5, y: 1.0)
                    grad.endPoint = CGPoint(x: 0.5, y: 0.0)
                } else {
                    grad.startPoint = CGPoint(x: 0.0, y: 0.5)
                    grad.endPoint = CGPoint(x: 1.0, y: 0.5)
                }
                grad.colors = [
                    c.withAlphaComponent(0.0).cgColor,
                    c.cgColor,
                    c.cgColor,
                    c.withAlphaComponent(0.0).cgColor,
                ]
                grad.locations = [0.0, 0.14, 0.86, 1.0]
            }
        }
        CATransaction.commit()
    }
}

// MARK: - Flipped Document Container for NSScrollView
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

// MARK: - Ultra-Thin Translucent Glass Overlay Scroller (Zero Legacy Track Gutter)
final class GlassScroller: NSScroller {
    var onHoverChanged: ((Bool) -> Void)?
    private(set) var isHovered = false {
        didSet {
            if oldValue != isHovered {
                needsDisplay = true
                onHoverChanged?(isHovered)
            }
        }
    }
    private(set) var isDraggingKnob = false
    private var trackingRef: NSTrackingArea?

    override class var isCompatibleWithOverlayScrollers: Bool { true }

    override class func scrollerWidth(for controlSize: NSControl.ControlSize, scrollerStyle: NSScroller.Style) -> CGFloat {
        11
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingRef { removeTrackingArea(existing) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingRef = area
    }

    override func mouseEntered(with event: NSEvent) {
        isHovered = true
        super.mouseEntered(with: event)
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
        super.mouseExited(with: event)
    }

    override func mouseDown(with event: NSEvent) {
        isDraggingKnob = true
        needsDisplay = true
        super.mouseDown(with: event)
        isDraggingKnob = false
        needsDisplay = true
        onHoverChanged?(isHovered)
    }

    // Never draw the chunky opaque legacy slot background
    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}

    override func drawKnob() {
        let knob = rect(for: .knob)
        guard knob.height > 4 else { return }
        let dark = Theme.isDark(self)
        let active = isHovered || isDraggingKnob
        let pillWidth: CGFloat = active ? 5.5 : 3.5
        let rightMargin: CGFloat = 3.0
        let vInset: CGFloat = 3.0
        let h = max(18.0, knob.height - vInset * 2)
        let pillRect = NSRect(
            x: bounds.width - pillWidth - rightMargin,
            y: knob.minY + vInset,
            width: pillWidth,
            height: min(knob.height, h)
        )
        let radius = pillWidth / 2.0
        let path = NSBezierPath(roundedRect: pillRect, xRadius: radius, yRadius: radius)

        let fillColor: NSColor
        if dark {
            fillColor = NSColor(white: 1.0, alpha: active ? 0.44 : 0.24)
        } else {
            fillColor = NSColor(srgbRed: 0.10, green: 0.14, blue: 0.24, alpha: active ? 0.36 : 0.20)
        }
        fillColor.setFill()
        path.fill()

        if active {
            let rim = NSColor(white: 1.0, alpha: dark ? 0.26 : 0.45)
            rim.setStroke()
            path.lineWidth = 0.5
            path.stroke()
        }
    }
}

final class GlassScrollView: NSScrollView {
    private let glassVerticalScroller = GlassScroller()
    private var fadeTimer: Timer?
    private var boundsObserver: Any?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    deinit {
        fadeTimer?.invalidate()
        if let obs = boundsObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    // Always force overlay style so external mice or macOS "Show scroll bars: Always" never paint a 15pt gutter.
    override var scrollerStyle: NSScroller.Style {
        get { .overlay }
        set { super.scrollerStyle = .overlay }
    }

    private func configure() {
        drawsBackground = false
        contentView.drawsBackground = false
        contentView.wantsLayer = true
        contentView.layer?.backgroundColor = NSColor.clear.cgColor
        borderType = .noBorder
        hasVerticalScroller = true
        hasHorizontalScroller = false
        autohidesScrollers = true
        super.scrollerStyle = .overlay

        glassVerticalScroller.alphaValue = 0.0
        glassVerticalScroller.onHoverChanged = { [weak self] hovered in
            guard let self = self else { return }
            if hovered {
                self.revealScroller(autoHide: false)
            } else {
                self.scheduleFadeOut()
            }
        }
        verticalScroller = glassVerticalScroller

        contentView.postsBoundsChangedNotifications = true
        boundsObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: contentView,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.revealScroller(autoHide: true)
            }
        }
    }

    private var canScrollVertically: Bool {
        guard let doc = documentView else { return false }
        return doc.bounds.height > contentView.bounds.height + 2.0
    }

    override func scrollWheel(with event: NSEvent) {
        super.scrollWheel(with: event)
        if canScrollVertically {
            revealScroller(autoHide: true)
        }
    }

    override func tile() {
        super.tile()
        // Keep full content width without reserving a legacy scrollbar column
        contentView.frame = bounds
        if let scroller = verticalScroller {
            let w: CGFloat = 11
            scroller.frame = NSRect(x: bounds.width - w, y: 4, width: w, height: max(0, bounds.height - 8))
            scroller.isHidden = !canScrollVertically
        }
    }

    func resetScrollerVisibility() {
        fadeTimer?.invalidate()
        fadeTimer = nil
        glassVerticalScroller.alphaValue = 0.0
    }

    private func revealScroller(autoHide: Bool) {
        guard canScrollVertically else {
            glassVerticalScroller.isHidden = true
            glassVerticalScroller.alphaValue = 0.0
            return
        }
        glassVerticalScroller.isHidden = false
        fadeTimer?.invalidate()
        fadeTimer = nil
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.14
            glassVerticalScroller.animator().alphaValue = 1.0
        }
        if autoHide && !glassVerticalScroller.isHovered && !glassVerticalScroller.isDraggingKnob {
            scheduleFadeOut()
        }
    }

    private func scheduleFadeOut() {
        fadeTimer?.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: 0.85, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                guard !self.glassVerticalScroller.isHovered && !self.glassVerticalScroller.isDraggingKnob else { return }
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.32
                    self.glassVerticalScroller.animator().alphaValue = 0.0
                }
            }
        }
        fadeTimer = timer
    }
}

// MARK: - Luminous Glass Squircle Brand Badge
final class BrandBadgeView: NSView {
    let provider: String
    let boxSize: CGFloat

    init(provider: String, size: CGFloat = 26) {
        self.provider = provider
        self.boxSize = size
        super.init(frame: .zero)
        self.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size),
            heightAnchor.constraint(equalToConstant: size),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: NSSize { NSSize(width: boxSize, height: boxSize) }

    override func draw(_ dirtyRect: NSRect) {
        let dark = Theme.isDark(self)
        let accent = BrandIcons.brandColor(for: provider, isDark: dark)
        let radius = (boxSize * 0.30).rounded()
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)

        if let grad = NSGradient(
            starting: accent.withAlphaComponent(dark ? 0.28 : 0.20),
            ending: accent.withAlphaComponent(dark ? 0.13 : 0.08)
        ) {
            grad.draw(in: path, angle: -90)
        } else {
            accent.withAlphaComponent(dark ? 0.22 : 0.14).setFill()
            path.fill()
        }

        Theme.drawGlassRim(
            in: bounds,
            radius: radius,
            topColor: NSColor(white: 1.0, alpha: dark ? 0.30 : 0.80),
            bottomColor: accent.withAlphaComponent(dark ? 0.22 : 0.18),
            lineWidth: 0.85
        )

        let iconDim = (boxSize * 0.56).rounded()
        let dst = NSRect(
            x: (bounds.width - iconDim) / 2.0,
            y: (bounds.height - iconDim) / 2.0,
            width: iconDim,
            height: iconDim
        )
        BrandIcons.drawTintedProvider(provider, color: accent, in: dst)
    }
}

// MARK: - Interactive Frosted Glass Left Navigation Rail Button
final class RailItemButton: NSControl {
    var icon: NSImage? { didSet { needsDisplay = true } }
    var providerName: String? { didSet { needsDisplay = true } }
    var isSelected: Bool = false { didSet { needsDisplay = true } }
    var statusDotColor: NSColor? { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?

    private var isHovered = false { didSet { needsDisplay = true } }
    private var trackingAreaRef: NSTrackingArea?

    override var intrinsicContentSize: NSSize { NSSize(width: 58, height: 42) }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingAreaRef { removeTrackingArea(existing) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingAreaRef = area
    }

    override func mouseEntered(with event: NSEvent) { isHovered = true }
    override func mouseExited(with event: NSEvent) { isHovered = false }
    override func mouseDown(with event: NSEvent) { alphaValue = 0.72 }
    override func mouseUp(with event: NSEvent) {
        alphaValue = 1.0
        let loc = convert(event.locationInWindow, from: nil)
        if bounds.contains(loc) { onClick?() }
    }

    override func draw(_ dirtyRect: NSRect) {
        let dark = Theme.isDark(self)
        let accent: NSColor = providerName.map { BrandIcons.brandColor(for: $0, isDark: dark) } ?? NSColor.controlAccentColor
        let boxRect = NSRect(x: 9, y: 2, width: bounds.width - 18, height: bounds.height - 4)

        if isSelected {
            let boxPath = NSBezierPath(roundedRect: boxRect, xRadius: 12, yRadius: 12)
            let baseFill = dark
                ? NSColor(srgbRed: 0.24, green: 0.26, blue: 0.34, alpha: 0.62)
                : NSColor(white: 1.0, alpha: 0.84)
            baseFill.setFill()
            boxPath.fill()

            NSGraphicsContext.saveGraphicsState()
            boxPath.addClip()
            // Subtle brand prism tint inside selected glass capsule
            if let tintGrad = NSGradient(
                starting: accent.withAlphaComponent(dark ? 0.26 : 0.15),
                ending: accent.withAlphaComponent(dark ? 0.08 : 0.04)
            ) {
                tintGrad.draw(in: boxRect, angle: -90)
            }
            // Top specular highlight sheen
            if let sheen = NSGradient(
                starting: NSColor(white: 1.0, alpha: dark ? 0.22 : 0.65),
                ending: NSColor(white: 1.0, alpha: 0.0)
            ) {
                sheen.draw(in: NSRect(x: boxRect.minX, y: boxRect.midY, width: boxRect.width, height: boxRect.height / 2.0), angle: -90)
            }
            NSGraphicsContext.restoreGraphicsState()

            Theme.drawGlassRim(
                in: boxRect,
                radius: 12,
                topColor: NSColor(white: 1.0, alpha: dark ? 0.36 : 0.98),
                bottomColor: accent.withAlphaComponent(dark ? 0.34 : 0.24),
                lineWidth: 1.0
            )
            // Luminous pill edge indicator
            let barRect = NSRect(x: 1.5, y: (bounds.height - 18) / 2, width: 3.0, height: 18)
            accent.setFill()
            NSBezierPath(roundedRect: barRect, xRadius: 1.5, yRadius: 1.5).fill()
        } else if isHovered {
            let fill = dark ? NSColor(white: 1.0, alpha: 0.11) : NSColor(white: 1.0, alpha: 0.48)
            fill.setFill()
            NSBezierPath(roundedRect: boxRect, xRadius: 12, yRadius: 12).fill()
            Theme.drawGlassRim(
                in: boxRect,
                radius: 12,
                topColor: NSColor(white: 1.0, alpha: dark ? 0.20 : 0.72),
                bottomColor: NSColor(white: 1.0, alpha: 0.04),
                lineWidth: 0.8
            )
        }

        if let img = icon {
            let iconSize = NSSize(width: 19, height: 19)
            let iconRect = NSRect(
                x: (bounds.width - iconSize.width) / 2.0,
                y: (bounds.height - iconSize.height) / 2.0,
                width: iconSize.width,
                height: iconSize.height
            )
            let tint: NSColor
            if isSelected {
                tint = accent
            } else if isHovered {
                tint = NSColor.labelColor.withAlphaComponent(0.92)
            } else {
                tint = NSColor.secondaryLabelColor.withAlphaComponent(0.88)
            }
            BrandIcons.drawTinted(img, color: tint, in: iconRect)
        }

        if let dot = statusDotColor {
            let dotCenter = NSPoint(x: bounds.width - 14.0, y: bounds.height - 10.5)
            let haloColor = dark ? NSColor(srgbRed: 0.10, green: 0.11, blue: 0.15, alpha: 0.92) : NSColor(white: 1.0, alpha: 0.92)
            haloColor.setFill()
            NSBezierPath(ovalIn: NSRect(x: dotCenter.x - 4.2, y: dotCenter.y - 4.2, width: 8.4, height: 8.4)).fill()

            dot.setFill()
            NSBezierPath(ovalIn: NSRect(x: dotCenter.x - 2.7, y: dotCenter.y - 2.7, width: 5.4, height: 5.4)).fill()
        }
    }
}

// MARK: - Tactile Liquid Glass Pill Action Button
final class GlassPillButton: NSControl {
    enum Tone {
        case neutral
        case accent
        case destructive
    }

    var titleText: String { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var tone: Tone { didSet { needsDisplay = true } }
    var compact: Bool
    var onClick: (() -> Void)?

    private var isHovered = false { didSet { needsDisplay = true } }
    private var isPressed = false { didSet { needsDisplay = true } }
    private var trackingRef: NSTrackingArea?

    init(title: String, tone: Tone = .neutral, compact: Bool = true, onClick: (() -> Void)? = nil) {
        self.titleText = title
        self.tone = tone
        self.compact = compact
        self.onClick = onClick
        super.init(frame: .zero)
        self.translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError() }

    private var textFont: NSFont {
        NSFont.systemFont(ofSize: compact ? 11.0 : 12.0, weight: .medium)
    }

    override var intrinsicContentSize: NSSize {
        let size = (titleText as NSString).size(withAttributes: [.font: textFont])
        let hPad: CGFloat = compact ? 9.5 : 13.0
        let height: CGFloat = compact ? 22.0 : 27.0
        return NSSize(width: ceil(size.width) + hPad * 2, height: height)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingRef { removeTrackingArea(existing) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingRef = area
    }

    override func mouseEntered(with event: NSEvent) {
        guard isEnabled else { return }
        isHovered = true
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
        isPressed = false
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        isPressed = true
    }

    override func mouseUp(with event: NSEvent) {
        guard isEnabled else { return }
        let wasPressed = isPressed
        isPressed = false
        let loc = convert(event.locationInWindow, from: nil)
        if wasPressed && bounds.contains(loc) {
            if let handler = onClick {
                handler()
            } else if let action = action {
                NSApp.sendAction(action, to: target, from: self)
            }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let dark = Theme.isDark(self)
        let radius = bounds.height / 2.0
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)

        let bg: NSColor
        let fg: NSColor
        let rimHigh: NSColor
        let rimLow: NSColor

        switch tone {
        case .neutral:
            if dark {
                bg = NSColor(white: 1.0, alpha: isPressed ? 0.19 : (isHovered ? 0.15 : 0.095))
            } else {
                bg = NSColor(white: 1.0, alpha: isPressed ? 0.94 : (isHovered ? 0.88 : 0.72))
            }
            fg = isEnabled ? .labelColor : .tertiaryLabelColor
            rimHigh = NSColor(white: 1.0, alpha: dark ? 0.24 : 0.95)
            rimLow = Theme.rimBottom(dark)

        case .accent:
            let accent = dark ? NSColor(srgbRed: 0.44, green: 0.74, blue: 1.0, alpha: 1.0) : NSColor.controlAccentColor
            bg = accent.withAlphaComponent(isPressed ? 0.30 : (isHovered ? 0.24 : (dark ? 0.22 : 0.14)))
            fg = isEnabled ? accent : .tertiaryLabelColor
            rimHigh = NSColor(white: 1.0, alpha: dark ? 0.30 : 0.85)
            rimLow = accent.withAlphaComponent(0.36)

        case .destructive:
            let red = dark ? NSColor(srgbRed: 1.0, green: 0.45, blue: 0.45, alpha: 1.0) : NSColor.systemRed
            bg = red.withAlphaComponent(isPressed ? 0.28 : (isHovered ? 0.22 : (dark ? 0.18 : 0.10)))
            fg = isEnabled ? red : .tertiaryLabelColor
            rimHigh = NSColor(white: 1.0, alpha: dark ? 0.24 : 0.80)
            rimLow = red.withAlphaComponent(0.32)
        }

        bg.setFill()
        path.fill()

        Theme.drawGlassRim(in: bounds, radius: radius, topColor: rimHigh, bottomColor: rimLow, lineWidth: 0.9)

        let attrs: [NSAttributedString.Key: Any] = [
            .font: textFont,
            .foregroundColor: fg,
        ]
        let ns = titleText as NSString
        let ts = ns.size(withAttributes: attrs)
        let textRect = NSRect(
            x: ((bounds.width - ts.width) / 2.0).rounded(),
            y: ((bounds.height - ts.height) / 2.0).rounded() - 0.5,
            width: ceil(ts.width),
            height: ceil(ts.height)
        )
        ns.draw(in: textRect, withAttributes: attrs)
    }
}

// MARK: - Luminous Brand-Gradient Capsule Progress Bar (Pure CALayer — Zero Backing Store)
final class QuotaProgressBarView: NSView {
    var providerName: String? { didSet { needsDisplay = true } }
    var usedPercent: Double? { didSet { needsDisplay = true } }
    var elapsedPercent: Double? { didSet { needsDisplay = true } }

    private let trackLayer = CALayer()
    private let fillLayer = CAGradientLayer()
    private let glossLayer = CAGradientLayer()
    private let haloLayer = CALayer()
    private let tickLayer = CALayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupLayers()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupLayers()
    }

    private func setupLayers() {
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay

        trackLayer.borderWidth = 0.7
        fillLayer.startPoint = CGPoint(x: 0.0, y: 0.5)
        fillLayer.endPoint = CGPoint(x: 1.0, y: 0.5)
        fillLayer.masksToBounds = true

        glossLayer.startPoint = CGPoint(x: 0.5, y: 1.0)
        glossLayer.endPoint = CGPoint(x: 0.5, y: 0.0)
        fillLayer.addSublayer(glossLayer)

        layer?.addSublayer(trackLayer)
        layer?.addSublayer(fillLayer)
        layer?.addSublayer(haloLayer)
        layer?.addSublayer(tickLayer)
    }

    override var wantsUpdateLayer: Bool { true }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 11) }

    override func layout() {
        super.layout()
        updateLayer()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func updateLayer() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        let dark = Theme.isDark(self)
        let trackHeight: CGFloat = 8.0
        let y = (bounds.height - trackHeight) / 2.0
        let radius = trackHeight / 2.0

        CATransaction.begin()
        CATransaction.setDisableActions(true)

        trackLayer.frame = CGRect(x: 0, y: y, width: bounds.width, height: trackHeight)
        trackLayer.cornerRadius = radius
        trackLayer.backgroundColor = Theme.trackBg(dark).cgColor
        trackLayer.borderColor = (dark
            ? NSColor(white: 1.0, alpha: 0.08)
            : NSColor(white: 0.1, alpha: 0.08)).cgColor

        if let used = usedPercent, used.isFinite, used > 0 {
            let clamped = max(0.0, min(100.0, used))
            let fillWidth = min(bounds.width, max(trackHeight, bounds.width * CGFloat(clamped / 100.0)))
            let (startColor, endColor) = Theme.barGradientColors(for: providerName, usedPercent: clamped, dark: dark)
            fillLayer.isHidden = false
            fillLayer.frame = CGRect(x: 0, y: y, width: fillWidth, height: trackHeight)
            fillLayer.cornerRadius = radius
            fillLayer.colors = [startColor.cgColor, endColor.cgColor]

            glossLayer.frame = CGRect(x: 0, y: trackHeight / 2.0, width: fillWidth, height: trackHeight / 2.0)
            glossLayer.colors = [
                NSColor(white: 1.0, alpha: dark ? 0.34 : 0.42).cgColor,
                NSColor(white: 1.0, alpha: 0.0).cgColor,
            ]
        } else {
            fillLayer.isHidden = true
        }

        if let elapsed = elapsedPercent, elapsed.isFinite, elapsed >= 3, elapsed <= 97 {
            let markerX = (bounds.width * CGFloat(elapsed / 100.0)).rounded()
            haloLayer.isHidden = false
            haloLayer.frame = CGRect(x: markerX - 1.75, y: 0, width: 3.5, height: bounds.height)
            haloLayer.cornerRadius = 1.75
            haloLayer.backgroundColor = (dark ? NSColor(white: 0.08, alpha: 0.72) : NSColor(white: 1.0, alpha: 0.85)).cgColor

            tickLayer.isHidden = false
            tickLayer.frame = CGRect(x: markerX - 0.75, y: 0.75, width: 1.5, height: bounds.height - 1.5)
            tickLayer.cornerRadius = 0.75
            tickLayer.backgroundColor = NSColor.labelColor.withAlphaComponent(dark ? 0.72 : 0.55).cgColor
        } else {
            haloLayer.isHidden = true
            tickLayer.isHidden = true
        }

        CATransaction.commit()
    }
}

// MARK: - Interactive Frosted Glass Overview Provider Card (Pure CALayer — Zero Backing Store)
final class ClickableCardView: NSView {
    var providerName: String? { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    private var isHovered = false { didSet { needsDisplay = true } }
    private var trackingRef: NSTrackingArea?

    private let sheenLayer = CAGradientLayer()
    private let hoverTintLayer = CALayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupLayers()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupLayers()
    }

    private func setupLayers() {
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        sheenLayer.startPoint = CGPoint(x: 0.5, y: 1.0)
        sheenLayer.endPoint = CGPoint(x: 0.5, y: 0.0)
        sheenLayer.zPosition = -2
        hoverTintLayer.zPosition = -1
        layer?.addSublayer(sheenLayer)
        layer?.addSublayer(hoverTintLayer)
    }

    override var wantsUpdateLayer: Bool { true }

    override func layout() {
        super.layout()
        updateLayer()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = trackingRef { removeTrackingArea(t) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingRef = area
    }

    override func mouseEntered(with event: NSEvent) { isHovered = true }
    override func mouseExited(with event: NSEvent) { isHovered = false }
    override func mouseDown(with event: NSEvent) { alphaValue = 0.92 }
    override func mouseUp(with event: NSEvent) {
        alphaValue = 1.0
        let loc = convert(event.locationInWindow, from: nil)
        if bounds.contains(loc) { onClick?() }
    }

    override func updateLayer() {
        guard let rootLayer = self.layer else { return }
        let dark = Theme.isDark(self)
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        rootLayer.cornerRadius = 15
        rootLayer.cornerCurve = .continuous
        rootLayer.masksToBounds = true
        rootLayer.backgroundColor = Theme.cardBg(dark, hovered: isHovered).cgColor
        rootLayer.borderWidth = 1.0

        if isHovered, let name = providerName {
            let accent = BrandIcons.brandColor(for: name, isDark: dark)
            rootLayer.borderColor = accent.withAlphaComponent(dark ? 0.44 : 0.36).cgColor
            hoverTintLayer.isHidden = false
            hoverTintLayer.frame = bounds
            hoverTintLayer.backgroundColor = accent.withAlphaComponent(dark ? 0.08 : 0.045).cgColor
        } else {
            rootLayer.borderColor = (dark
                ? NSColor(white: 1.0, alpha: 0.14)
                : NSColor(white: 1.0, alpha: 0.78)).cgColor
            hoverTintLayer.isHidden = true
        }

        let topH = min(34.0, bounds.height)
        sheenLayer.frame = CGRect(x: 0, y: bounds.height - topH, width: bounds.width, height: topH)
        sheenLayer.colors = [
            Theme.cardSheenTop(dark).cgColor,
            NSColor(white: 1.0, alpha: 0.0).cgColor,
        ]
        CATransaction.commit()
    }
}

// MARK: - Appearance-Aware Frosted Glass Pill Badge (Pure CALayer — Zero Backing Store)
final class GlassBadgeView: NSView {
    let customBg: NSColor?
    let customBorder: NSColor?

    init(bgColor: NSColor?, borderColor: NSColor?) {
        self.customBg = bgColor
        self.customBorder = borderColor
        super.init(frame: .zero)
        self.translatesAutoresizingMaskIntoConstraints = false
        self.wantsLayer = true
        self.layerContentsRedrawPolicy = .onSetNeedsDisplay
    }

    required init?(coder: NSCoder) { fatalError() }

    override var wantsUpdateLayer: Bool { true }

    override func layout() {
        super.layout()
        updateLayer()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func updateLayer() {
        guard let rootLayer = self.layer else { return }
        let dark = Theme.isDark(self)
        let radius = min(8.0, bounds.height / 2.0)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        rootLayer.cornerRadius = radius
        rootLayer.cornerCurve = .continuous
        rootLayer.masksToBounds = true
        rootLayer.backgroundColor = (customBg ?? (dark ? NSColor(white: 1.0, alpha: 0.11) : NSColor(white: 1.0, alpha: 0.66))).cgColor
        rootLayer.borderWidth = 0.8
        rootLayer.borderColor = (customBorder ?? (dark ? NSColor(white: 1.0, alpha: 0.18) : NSColor(white: 1.0, alpha: 0.78))).cgColor
        CATransaction.commit()
    }
}

// MARK: - UI Component Factory
@MainActor
enum UI {
    static func roundedMetricFont(size: CGFloat, weight: NSFont.Weight = .bold) -> NSFont {
        let base = NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
        if let desc = base.fontDescriptor.withDesign(.rounded),
           let rounded = NSFont(descriptor: desc, size: size) {
            return rounded
        }
        return base
    }

    static func label(
        _ text: String,
        size: CGFloat = 12.5,
        weight: NSFont.Weight = .regular,
        color: NSColor = .labelColor,
        monospacedDigits: Bool = false,
        rounded: Bool = false,
        wraps: Bool = false,
        compressible: Bool = false
    ) -> NSTextField {
        let tf = wraps ? NSTextField(wrappingLabelWithString: text) : NSTextField(labelWithString: text)
        if rounded {
            tf.font = roundedMetricFont(size: size, weight: weight)
        } else if monospacedDigits {
            tf.font = NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
        } else {
            tf.font = NSFont.systemFont(ofSize: size, weight: weight)
        }
        tf.textColor = color
        tf.lineBreakMode = wraps ? .byWordWrapping : .byTruncatingTail
        tf.translatesAutoresizingMaskIntoConstraints = false
        if wraps || compressible {
            tf.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        } else {
            tf.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        return tf
    }

    static func pillBadge(_ text: String, textColor: NSColor = .secondaryLabelColor, bgColor: NSColor? = nil, borderColor: NSColor? = nil) -> NSView {
        let container = GlassBadgeView(bgColor: bgColor, borderColor: borderColor)
        let lbl = label(text, size: 10.5, weight: .semibold, color: textColor, monospacedDigits: true)
        container.addSubview(lbl)
        NSLayoutConstraint.activate([
            lbl.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 7.5),
            lbl.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -7.5),
            lbl.topAnchor.constraint(equalTo: container.topAnchor, constant: 2.5),
            lbl.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -2.5),
        ])
        return container
    }

    static func cardContainer(padding: CGFloat = 13, spacing: CGFloat = 9) -> (card: SurfaceView, stack: NSStackView) {
        let card = SurfaceView(kind: .card, cornerRadius: 15)
        let stack = vstack(spacing: spacing)
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: padding),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -padding),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: padding),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -padding),
        ])
        return (card, stack)
    }

    static func vstack(spacing: CGFloat = 8, alignment: NSLayoutConstraint.Attribute = .leading) -> NSStackView {
        let s = NSStackView()
        s.orientation = .vertical
        s.alignment = alignment
        s.spacing = spacing
        s.translatesAutoresizingMaskIntoConstraints = false
        return s
    }

    static func hstack(spacing: CGFloat = 6, alignment: NSLayoutConstraint.Attribute = .centerY) -> NSStackView {
        let s = NSStackView()
        s.orientation = .horizontal
        s.alignment = alignment
        s.spacing = spacing
        s.translatesAutoresizingMaskIntoConstraints = false
        return s
    }

    static func spacer() -> NSView {
        let v = NSView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.setContentHuggingPriority(.init(1), for: .horizontal)
        v.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        return v
    }

    static func hairline(vertical: Bool = false) -> NSView {
        let v = SurfaceView(kind: .hairline)
        v.vertical = vertical
        if vertical {
            v.widthAnchor.constraint(equalToConstant: 1).isActive = true
        } else {
            v.heightAnchor.constraint(equalToConstant: 1).isActive = true
        }
        return v
    }

    static func buildWindowRow(_ win: WindowDto, providerName: String? = nil, now: Date = Date(), compact: Bool = false) -> NSView {
        let rowStack = vstack(spacing: compact ? 5.0 : 6.0)

        // Row 1: Window Name + Compact Pace Pill ... Remaining %
        let topRow = hstack(spacing: 6)
        let titleLbl = label(win.label, size: compact ? 12.0 : 13.0, weight: .medium, compressible: true)
        topRow.addArrangedSubview(titleLbl)

        if let pace = win.pace {
            if pace.status == "critical" {
                let txt = pace.ratio.map { String(format: "⚡ %.1fx", $0) } ?? "⚡ 超速"
                topRow.addArrangedSubview(pillBadge(
                    txt,
                    textColor: .systemRed,
                    bgColor: NSColor.systemRed.withAlphaComponent(0.13),
                    borderColor: NSColor.systemRed.withAlphaComponent(0.24)
                ))
            } else if pace.status == "ahead" {
                let txt = pace.ratio.map { String(format: "⚡ %.1fx", $0) } ?? "偏快"
                topRow.addArrangedSubview(pillBadge(
                    txt,
                    textColor: .systemOrange,
                    bgColor: NSColor.systemOrange.withAlphaComponent(0.14),
                    borderColor: NSColor.systemOrange.withAlphaComponent(0.24)
                ))
            }
        }

        topRow.addArrangedSubview(spacer())

        if let rem = win.remainingPercent, let used = win.usedPercent {
            let remColor: NSColor
            if used >= 85 { remColor = .systemRed }
            else if used >= 65 { remColor = .systemOrange }
            else { remColor = .labelColor }
            let remLbl = label(
                String(format: "%.0f%% 剩余", rem.rounded()),
                size: compact ? 12.0 : 13.0,
                weight: .semibold,
                color: remColor,
                rounded: true
            )
            topRow.addArrangedSubview(remLbl)
        } else {
            topRow.addArrangedSubview(label("未知", size: 11.5, color: .tertiaryLabelColor))
        }

        rowStack.addArrangedSubview(topRow)
        topRow.widthAnchor.constraint(equalTo: rowStack.widthAnchor).isActive = true

        // Row 2: Luminous Brand-Gradient Capsule Progress Bar
        let bar = QuotaProgressBarView()
        bar.providerName = providerName
        bar.usedPercent = win.usedPercent
        bar.elapsedPercent = win.pace?.elapsedPercent
        bar.translatesAutoresizingMaskIntoConstraints = false
        rowStack.addArrangedSubview(bar)
        bar.widthAnchor.constraint(equalTo: rowStack.widthAnchor).isActive = true

        // Row 3: Left Used % (+ ETA if fast-burning) ... Right Concise Reset Countdown
        let bottomRow = hstack(spacing: 6)
        var leftParts: [String] = []
        if let used = win.usedPercent {
            leftParts.append(String(format: "已用 %.0f%%", used.rounded()))
        }
        if !compact, let pace = win.pace, (pace.status == "critical" || pace.status == "ahead"), let eta = pace.exhaustsAtDate {
            let shortEta = Formatters.formatRelativeCountdown(to: eta, now: now).replacingOccurrences(of: " 后", with: "")
            leftParts.append("约 \(shortEta) 耗尽")
        }
        let isWarningEta = !compact && (win.pace?.status == "critical" || win.pace?.status == "ahead") && win.pace?.exhaustsAtDate != nil
        let leftColor: NSColor = isWarningEta
            ? (win.pace?.status == "critical" ? .systemRed : .systemOrange)
            : .secondaryLabelColor
        let leftSub = label(leftParts.joined(separator: " · "), size: 11.0, color: leftColor, monospacedDigits: true, compressible: true)
        bottomRow.addArrangedSubview(leftSub)
        bottomRow.addArrangedSubview(spacer())

        if let resetDate = win.resetsAtDate {
            let countdown = Formatters.formatRelativeCountdown(to: resetDate, now: now)
            let resetText = countdown == "已到点" ? "已到重置点" : "\(countdown.replacingOccurrences(of: " 后", with: "")) 后重置"
            let rightSub = label(resetText, size: 11.0, color: .secondaryLabelColor, monospacedDigits: true)
            rightSub.toolTip = "重置时间：\(Formatters.formatWhen(resetDate, now: now))"
            bottomRow.addArrangedSubview(rightSub)
        }

        rowStack.addArrangedSubview(bottomRow)
        bottomRow.widthAnchor.constraint(equalTo: rowStack.widthAnchor).isActive = true

        return rowStack
    }

    static func settingToggleRow(title: String, subtitle: String? = nil, isOn: Bool, target: AnyObject, action: Selector, identifier: String? = nil) -> NSView {
        let row = hstack(spacing: 10)
        let textCol = vstack(spacing: 2)
        textCol.addArrangedSubview(label(title, size: 12.5, weight: .medium, compressible: true))
        if let sub = subtitle {
            let subLbl = label(sub, size: 11.0, color: .secondaryLabelColor, wraps: true)
            textCol.addArrangedSubview(subLbl)
            subLbl.widthAnchor.constraint(equalTo: textCol.widthAnchor).isActive = true
        }
        row.addArrangedSubview(textCol)
        row.addArrangedSubview(spacer())

        let toggle = NSSwitch()
        toggle.controlSize = .small
        toggle.state = isOn ? .on : .off
        toggle.target = target
        toggle.action = action
        if let id = identifier {
            toggle.identifier = NSUserInterfaceItemIdentifier(id)
        }
        toggle.translatesAutoresizingMaskIntoConstraints = false
        row.addArrangedSubview(toggle)
        return row
    }
}
