import AppKit
import CoreGraphics

@MainActor
enum BrandIcons {
    // Pure vector geometry (exact SVG path/polygon definitions rendered directly via CoreGraphics,
    // avoiding libCoreSVG / libxml2 loading and preventing NSCustomImageRep closure retention).
    private static let gaugePathData = "M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2ZM12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4ZM15.8329 7.33748C16.0697 7.17128 16.3916 7.19926 16.5962 7.40381C16.8002 7.60784 16.8267 7.92955 16.6587 8.16418C14.479 11.2095 13.2796 12.8417 13.0607 13.0607C12.4749 13.6464 11.5251 13.6464 10.9393 13.0607C10.3536 12.4749 10.3536 11.5251 10.9393 10.9393C11.3126 10.5661 12.9438 9.36549 15.8329 7.33748ZM17.5 11C18.0523 11 18.5 11.4477 18.5 12C18.5 12.5523 18.0523 13 17.5 13C16.9477 13 16.5 12.5523 16.5 12C16.5 11.4477 16.9477 11 17.5 11ZM6.5 11C7.05228 11 7.5 11.4477 7.5 12C7.5 12.5523 7.05228 13 6.5 13C5.94772 13 5.5 12.5523 5.5 12C5.5 11.4477 5.94772 11 6.5 11ZM8.81802 7.40381C9.20854 7.79433 9.20854 8.4275 8.81802 8.81802C8.4275 9.20854 7.79433 9.20854 7.40381 8.81802C7.01328 8.4275 7.01328 7.79433 7.40381 7.40381C7.79433 7.01328 8.4275 7.01328 8.81802 7.40381ZM12 5.5C12.5523 5.5 13 5.94772 13 6.5C13 7.05228 12.5523 7.5 12 7.5C11.4477 7.5 11 7.05228 11 6.5C11 5.94772 11.4477 5.5 12 5.5Z"

    private static let claudePathData = "M25.7146 63.2153L41.4393 54.3917L41.7025 53.6226L41.4393 53.1976H40.6705L38.0394 53.0359L29.054 52.7929L21.2624 52.4691L13.7134 52.0644L11.8111 51.6594L10.0303 49.3118L10.2123 48.138L11.8111 47.0657L14.0981 47.2681L19.1574 47.6119L26.7467 48.138L32.2516 48.4618L40.4073 49.3118H41.7025L41.8846 48.7857L41.4393 48.4618L41.0955 48.138L33.243 42.8155L24.7432 37.1894L20.2909 33.9513L17.8824 32.3119L16.6684 30.774L16.1422 27.4147L18.328 25.0062L21.2624 25.2088L22.0112 25.4112L24.9861 27.6979L31.3407 32.616L39.6381 38.7273L40.8525 39.7391L41.3381 39.395L41.399 39.1523L40.8525 38.2415L36.3394 30.0858L31.5227 21.7883L29.3775 18.3478L28.811 16.2837C28.6087 15.4334 28.4669 14.7252 28.4669 13.8549L30.9563 10.4753L32.3321 10.0303L35.6515 10.4756L37.0479 11.6897L39.112 16.4052L42.4513 23.8327L47.6321 33.9313L49.15 36.9265L49.9594 39.6991L50.2632 40.5491H50.7894V40.0632L51.2141 34.3766L52.0035 27.3944L52.7726 18.4087L53.0358 15.8793L54.2905 12.8435L56.7795 11.2041L58.7224 12.135L60.3212 14.422L60.0986 15.899L59.1474 22.0718L57.2857 31.7458L56.0713 38.2218H56.7795L57.5892 37.4121L60.8677 33.061L66.3723 26.18L68.801 23.448L71.6342 20.4325L73.4556 18.9957H76.8962L79.4255 22.7601L78.2926 26.6456L74.7509 31.1384L71.8163 34.943L67.607 40.6097L64.9758 45.1431L65.2188 45.5072L65.8464 45.4466L75.358 43.4228L80.4984 42.4917L86.6304 41.4393L89.4033 42.7346L89.7065 44.0502L88.6135 46.7419L82.0566 48.3607L74.3662 49.8989L62.9118 52.6109L62.77 52.7121L62.9321 52.9144L68.0925 53.4L70.2987 53.5214H75.7021L85.7601 54.2702L88.3912 56.0108L89.9697 58.1358L89.7065 59.7545L85.6589 61.8189L80.1949 60.5236L67.4452 57.4881L63.0735 56.3952H62.4665V56.7596L66.1093 60.3213L72.7877 66.3523L81.1461 74.1236L81.5707 76.0462L80.4984 77.5638L79.3649 77.4021L72.0186 71.8772L69.1854 69.3879L62.77 63.9844H62.3453V64.5509L63.8223 66.7164L71.6342 78.4544L72.0389 82.0567L71.4725 83.2308L69.4487 83.939L67.2222 83.534L62.6485 77.1189L57.9333 69.8937L54.1284 63.4177L53.6631 63.6809L51.4167 87.8651L50.3644 89.0995L47.9356 90.0303L45.9121 88.4924L44.8392 86.0031L45.9118 81.0852L47.2071 74.6701L48.2594 69.5699L49.2106 63.2356L49.7773 61.131L49.7367 60.9892L49.2715 61.0498L44.4954 67.607L37.23 77.4224L31.4825 83.5746L30.1063 84.1211L27.7181 82.8864L27.9408 80.6805L29.2763 78.7177L37.2297 68.5988L42.026 62.3248L45.1227 58.7025L45.1024 58.176H44.9204L23.7917 71.8975L20.0274 72.3831L18.4083 70.8655L18.6106 68.3761L19.3798 67.5664L25.7343 63.195L25.7146 63.2153Z"

    private static let codexPathData = "M83.7733 42.8087C84.6678 40.1149 84.9771 37.2613 84.6807 34.4385C84.3843 31.6156 83.489 28.8885 82.0544 26.4394C77.6908 18.8436 68.9203 14.9365 60.3548 16.7725C57.9831 14.1344 54.9591 12.1668 51.5864 11.0673C48.2137 9.96772 44.611 9.77498 41.1402 10.5084C37.6694 11.2418 34.4527 12.8755 31.8132 15.2455C29.1736 17.6155 27.204 20.6383 26.1024 24.0103C23.3212 24.5806 20.6938 25.738 18.3958 27.405C16.0977 29.0721 14.1819 31.2104 12.7765 33.6772C8.36538 41.2609 9.3669 50.8267 15.2527 57.3327C14.3549 60.0251 14.0424 62.8782 14.3361 65.7012C14.6298 68.5241 15.523 71.2518 16.9558 73.7017C21.325 81.3002 30.1011 85.207 38.6712 83.3686C40.5554 85.4904 42.8707 87.1858 45.4623 88.3416C48.0539 89.4975 50.8622 90.0871 53.6999 90.0713C62.4793 90.079 70.2575 84.4114 72.9393 76.0515C75.7201 75.4802 78.347 74.3225 80.6449 72.6555C82.9427 70.9886 84.8587 68.8507 86.2649 66.3846C90.6227 58.8145 89.6172 49.3005 83.7733 42.8087ZM53.6999 84.8356C50.1955 84.8411 46.801 83.6129 44.1116 81.3661L44.5848 81.098L60.5123 71.9043C60.9087 71.6718 61.2379 71.3402 61.4674 70.942C61.6969 70.5439 61.8189 70.0929 61.8215 69.6333V47.1769L68.5553 51.072C68.6225 51.1063 68.6694 51.1707 68.6814 51.2456V69.854C68.6641 78.1208 61.9667 84.8183 53.6999 84.8356ZM21.4977 71.0843C19.7402 68.0497 19.1092 64.4925 19.7156 61.0386L20.1885 61.3225L36.1321 70.5165C36.5266 70.748 36.9757 70.87 37.4331 70.87C37.8905 70.87 38.3396 70.748 38.7341 70.5165L58.21 59.2883V67.0628C58.2081 67.1031 58.1973 67.1424 58.1782 67.1779C58.1591 67.2134 58.1322 67.2441 58.0996 67.2678L41.9671 76.5722C34.798 80.7022 25.6388 78.2463 21.4977 71.0843ZM17.3026 36.3898C19.0723 33.3357 21.8655 31.0062 25.1878 29.8138V48.7376C25.1818 49.1949 25.2986 49.6453 25.5261 50.042C25.7535 50.4387 26.0833 50.7671 26.4809 50.9928L45.8622 62.1739L39.1283 66.069C39.0919 66.0883 39.0513 66.0984 39.0101 66.0984C38.9689 66.0984 38.9283 66.0883 38.8919 66.069L22.7908 56.7809C15.6359 52.6337 13.1822 43.4816 17.3026 36.3112V36.3898ZM72.624 49.2426L53.1792 37.9512L59.8976 34.0718C59.9341 34.0524 59.9747 34.0423 60.016 34.0423C60.0573 34.0423 60.0979 34.0524 60.1344 34.0718L76.2355 43.3761C78.6973 44.7966 80.7043 46.8882 82.0221 49.4065C83.3398 51.9249 83.914 54.7661 83.6775 57.5985C83.4411 60.431 82.4038 63.1377 80.6867 65.4027C78.9696 67.6677 76.6436 69.3975 73.9803 70.3901V51.466C73.9663 51.0096 73.834 50.5647 73.5962 50.1749C73.3584 49.7851 73.0234 49.4638 72.624 49.2426ZM79.3261 39.1657L78.8529 38.8815L62.9411 29.6089C62.5442 29.376 62.0924 29.2532 61.6322 29.2532C61.172 29.2532 60.7202 29.376 60.3233 29.6089L40.8629 40.8374V33.0628C40.8587 33.0233 40.8654 32.9834 40.882 32.9473C40.8987 32.9113 40.9248 32.8803 40.9575 32.8579L57.0586 23.5692C59.5263 22.1476 62.3478 21.458 65.193 21.5811C68.0382 21.7042 70.7896 22.6348 73.1253 24.2642C75.461 25.8936 77.2845 28.1543 78.3825 30.782C79.4806 33.4097 79.8077 36.2957 79.3257 39.1025V39.1657H79.3261ZM37.1888 52.9484L30.455 49.069C30.4213 49.0487 30.3925 49.0212 30.3707 48.9884C30.3488 48.9557 30.3345 48.9186 30.3286 48.8797V30.3188C30.3323 27.4714 31.1466 24.6839 32.6761 22.2822C34.2057 19.8805 36.3874 17.9639 38.9661 16.7564C41.5448 15.549 44.4139 15.1005 47.2381 15.4636C50.0622 15.8267 52.7247 16.9862 54.9141 18.8067L54.4409 19.0748L38.5134 28.2686C38.117 28.5011 37.7879 28.8327 37.5584 29.2308C37.329 29.629 37.207 30.0799 37.2045 30.5395L37.1888 52.9487V52.9484ZM40.8472 45.0632L49.5209 40.0643L58.21 45.0635V55.0615L49.5523 60.0608L40.8632 55.0615L40.8472 45.0632Z"

    private static let agyPathData = "M85.2843 88.0301C90.1329 91.6664 97.4057 89.2422 90.7389 82.5755C70.7389 63.1816 74.9813 9.84827 50.1329 9.84827C25.2843 9.84827 29.5267 63.1816 9.52673 82.5755C2.25402 89.8483 10.1328 91.6664 14.9813 88.0301C33.7692 75.3028 32.5571 52.8786 50.1329 52.8786C67.7086 52.8786 66.4965 75.3028 85.2843 88.0301Z"

    private static let grokPolygons: [[CGPoint]] = [
        [CGPoint(x: 508.67, y: 574.07), CGPoint(x: 761.27, y: 213.32), CGPoint(x: 639.19, y: 213.32), CGPoint(x: 447.64, y: 486.9)],
        [CGPoint(x: 356.08, y: 792), CGPoint(x: 417.12, y: 704.83), CGPoint(x: 356.08, y: 617.66), CGPoint(x: 234, y: 792)],
        [CGPoint(x: 508.67, y: 792), CGPoint(x: 630.75, y: 792), CGPoint(x: 356.08, y: 399.72), CGPoint(x: 234, y: 399.72)],
        [CGPoint(x: 761.27, y: 256.91), CGPoint(x: 661.27, y: 399.72), CGPoint(x: 671.27, y: 792), CGPoint(x: 751.27, y: 792)],
    ]

    private struct CachedIcon {
        let cgImage: CGImage
        let image: NSImage
        let isMenuBar: Bool
    }

    private static var cache: [String: CachedIcon] = [:]

    private static var backingScale: CGFloat {
        let s = NSScreen.main?.backingScaleFactor ?? 2.0
        return max(2.0, min(3.0, s))
    }

    /// Drops panel-only rasterized icons after the floating panel tears down (keeping menu bar icons warm).
    static func trimPanelCache() {
        cache = cache.filter { $0.value.isMenuBar }
    }

    private static func buildCGPath(from d: String) -> CGPath {
        let path = CGMutablePath()
        let bytes = Array(d.utf8)
        let n = bytes.count
        var i = 0
        var cmd: UInt8 = 0
        var cur = CGPoint.zero
        var start = CGPoint.zero

        func skipSep() {
            while i < n {
                let c = bytes[i]
                if c == 32 || c == 9 || c == 10 || c == 13 || c == 44 { i += 1 } else { break }
            }
        }

        func isCommand(_ c: UInt8) -> Bool {
            (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
        }

        func readNumber() -> CGFloat? {
            skipSep()
            guard i < n else { return nil }
            let startIdx = i
            if bytes[i] == 43 || bytes[i] == 45 { i += 1 }
            var sawDigit = false
            while i < n && bytes[i] >= 48 && bytes[i] <= 57 { sawDigit = true; i += 1 }
            if i < n && bytes[i] == 46 {
                i += 1
                while i < n && bytes[i] >= 48 && bytes[i] <= 57 { sawDigit = true; i += 1 }
            }
            if sawDigit && i < n && (bytes[i] == 69 || bytes[i] == 101) {
                let expPos = i
                i += 1
                if i < n && (bytes[i] == 43 || bytes[i] == 45) { i += 1 }
                var expDigits = false
                while i < n && bytes[i] >= 48 && bytes[i] <= 57 { expDigits = true; i += 1 }
                if !expDigits { i = expPos }
            }
            guard sawDigit, let str = String(bytes: bytes[startIdx..<i], encoding: .ascii),
                  let val = Double(str) else {
                i = startIdx
                return nil
            }
            return CGFloat(val)
        }

        while i < n {
            skipSep()
            guard i < n else { break }
            if isCommand(bytes[i]) {
                cmd = bytes[i]
                i += 1
            } else if cmd == 0 {
                break
            }
            switch cmd {
            case 77, 109: // M / m
                guard let x = readNumber(), let y = readNumber() else { i = n; break }
                let pt = (cmd == 109) ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                path.move(to: pt)
                cur = pt
                start = pt
                cmd = (cmd == 109) ? 108 : 76 // implicit L/l for trailing pairs
            case 76, 108: // L / l
                guard let x = readNumber(), let y = readNumber() else { i = n; break }
                let pt = (cmd == 108) ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                path.addLine(to: pt)
                cur = pt
            case 72, 104: // H / h
                guard let x = readNumber() else { i = n; break }
                let nx = (cmd == 104) ? (cur.x + x) : x
                cur = CGPoint(x: nx, y: cur.y)
                path.addLine(to: cur)
            case 86, 118: // V / v
                guard let y = readNumber() else { i = n; break }
                let ny = (cmd == 118) ? (cur.y + y) : y
                cur = CGPoint(x: cur.x, y: ny)
                path.addLine(to: cur)
            case 67, 99: // C / c
                guard let x1 = readNumber(), let y1 = readNumber(),
                      let x2 = readNumber(), let y2 = readNumber(),
                      let x = readNumber(), let y = readNumber() else { i = n; break }
                let rel = (cmd == 99)
                let c1 = CGPoint(x: rel ? cur.x + x1 : x1, y: rel ? cur.y + y1 : y1)
                let c2 = CGPoint(x: rel ? cur.x + x2 : x2, y: rel ? cur.y + y2 : y2)
                let end = CGPoint(x: rel ? cur.x + x : x, y: rel ? cur.y + y : y)
                path.addCurve(to: end, control1: c1, control2: c2)
                cur = end
            case 90, 122: // Z / z
                path.closeSubpath()
                cur = start
                cmd = 0
            default:
                i = n
            }
        }
        return path
    }

    private static func buildGrokPath() -> CGPath {
        let path = CGMutablePath()
        for poly in grokPolygons {
            guard let first = poly.first else { continue }
            path.move(to: CGPoint(x: first.x - 134.0, y: first.y - 113.32))
            for pt in poly.dropFirst() {
                path.addLine(to: CGPoint(x: pt.x - 134.0, y: pt.y - 113.32))
            }
            path.closeSubpath()
        }
        return path
    }

    private static func rasterizeTemplate(
        key: String,
        size: NSSize,
        isMenuBar: Bool,
        viewBox: NSSize,
        makePath: () -> CGPath
    ) -> CachedIcon {
        let cacheKey = "\(key)_\(Int((size.width * 10).rounded()))x\(Int((size.height * 10).rounded()))"
        if let hit = cache[cacheKey] {
            if isMenuBar && !hit.isMenuBar {
                let promoted = CachedIcon(cgImage: hit.cgImage, image: hit.image, isMenuBar: true)
                cache[cacheKey] = promoted
                return promoted
            }
            return hit
        }

        let scale = backingScale
        let pxW = max(1, Int((size.width * scale).rounded()))
        let pxH = max(1, Int((size.height * scale).rounded()))
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

        guard let ctx = CGContext(
            data: nil,
            width: pxW,
            height: pxH,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else {
            let fallback = NSImage(size: size)
            fallback.isTemplate = true
            let dummy = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: colorSpace, bitmapInfo: bitmapInfo)!.makeImage()!
            return CachedIcon(cgImage: dummy, image: fallback, isMenuBar: isMenuBar)
        }

        autoreleasepool {
            ctx.setShouldAntialias(true)
            ctx.setAllowsAntialiasing(true)
            let fitScale = min(CGFloat(pxW) / viewBox.width, CGFloat(pxH) / viewBox.height)
            let drawW = viewBox.width * fitScale
            let drawH = viewBox.height * fitScale
            let ox = (CGFloat(pxW) - drawW) / 2.0
            let oy = (CGFloat(pxH) - drawH) / 2.0

            ctx.translateBy(x: ox, y: oy + drawH)
            ctx.scaleBy(x: fitScale, y: -fitScale)
            ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
            ctx.addPath(makePath())
            ctx.fillPath()
        }

        let cgImg = ctx.makeImage()!
        let nsImg = NSImage(cgImage: cgImg, size: size)
        nsImg.isTemplate = true
        let entry = CachedIcon(cgImage: cgImg, image: nsImg, isMenuBar: isMenuBar)
        cache[cacheKey] = entry
        return entry
    }

    private static func iconEntry(for key: String, size: NSSize, isMenuBar: Bool) -> CachedIcon {
        switch key {
        case "Claude":
            return rasterizeTemplate(key: "claude", size: size, isMenuBar: isMenuBar, viewBox: NSSize(width: 100, height: 100)) {
                buildCGPath(from: claudePathData)
            }
        case "Codex":
            return rasterizeTemplate(key: "codex", size: size, isMenuBar: isMenuBar, viewBox: NSSize(width: 100, height: 100)) {
                buildCGPath(from: codexPathData)
            }
        case "Grok":
            return rasterizeTemplate(key: "grok", size: size, isMenuBar: isMenuBar, viewBox: NSSize(width: 727.27, height: 778.68)) {
                buildGrokPath()
            }
        case "agy":
            return rasterizeTemplate(key: "agy", size: size, isMenuBar: isMenuBar, viewBox: NSSize(width: 100, height: 100)) {
                buildCGPath(from: agyPathData)
            }
        default:
            return rasterizeTemplate(key: "gauge", size: size, isMenuBar: isMenuBar, viewBox: NSSize(width: 24, height: 24)) {
                buildCGPath(from: gaugePathData)
            }
        }
    }

    nonisolated static func brandColor(for provider: String, isDark: Bool = false) -> NSColor {
        switch provider {
        case "Claude":
            return NSColor(srgbRed: 0.851, green: 0.467, blue: 0.341, alpha: 1.0) // #D97757
        case "Codex":
            return NSColor(srgbRed: 0.063, green: 0.639, blue: 0.498, alpha: 1.0) // #10A37F
        case "Grok":
            return isDark ? NSColor(srgbRed: 0.95, green: 0.95, blue: 0.97, alpha: 1.0) : NSColor(srgbRed: 0.11, green: 0.12, blue: 0.15, alpha: 1.0)
        case "agy":
            return NSColor(srgbRed: 0.259, green: 0.522, blue: 0.957, alpha: 1.0) // #4285F4
        default:
            return NSColor.controlAccentColor
        }
    }

    static func menuBarIcon(size: NSSize = NSSize(width: 16, height: 16)) -> NSImage {
        iconEntry(for: "gauge", size: size, isMenuBar: true).image
    }

    static func providerIcon(_ name: String, size: NSSize = NSSize(width: 18, height: 18), isMenuBar: Bool = false) -> NSImage {
        iconEntry(for: name, size: size, isMenuBar: isMenuBar).image
    }

    static func providerCGImage(_ name: String, size: NSSize = NSSize(width: 18, height: 18), isMenuBar: Bool = false) -> CGImage {
        iconEntry(for: name, size: size, isMenuBar: isMenuBar).cgImage
    }

    static func navIcon(for tab: NavigationTab, active: Bool, size: NSSize = NSSize(width: 18, height: 18)) -> NSImage {
        switch tab {
        case .overview:
            return iconEntry(for: "gauge", size: size, isMenuBar: false).image
        case .settings:
            if let sym = NSImage(systemSymbolName: active ? "gearshape.fill" : "gearshape", accessibilityDescription: "设置") {
                sym.isTemplate = true
                return sym
            }
            return iconEntry(for: "gauge", size: size, isMenuBar: false).image
        case .provider(let name):
            return iconEntry(for: name, size: size, isMenuBar: false).image
        }
    }

    static func refreshIcon() -> NSImage {
        if let sym = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "刷新") {
            sym.isTemplate = true
            return sym
        }
        return iconEntry(for: "gauge", size: NSSize(width: 16, height: 16), isMenuBar: false).image
    }

    /// Draws a template icon directly into the active graphics context tinted with `color`
    /// (zero intermediate `NSImage` / `NSCGImageSnapshotRep` allocation per draw).
    static func drawTinted(_ source: NSImage, color: NSColor, in rect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        var proposed = rect
        if let cg = source.cgImage(forProposedRect: &proposed, context: NSGraphicsContext.current, hints: nil) {
            ctx.saveGState()
            ctx.clip(to: rect, mask: cg)
            ctx.setFillColor(color.cgColor)
            ctx.fill(rect)
            ctx.restoreGState()
            return
        }
        source.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1.0)
    }

    static func drawTintedProvider(_ provider: String, color: NSColor, in rect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let cg = providerCGImage(provider, size: rect.size, isMenuBar: false)
        ctx.saveGState()
        ctx.clip(to: rect, mask: cg)
        ctx.setFillColor(color.cgColor)
        ctx.fill(rect)
        ctx.restoreGState()
    }

    /// Renders a crisp, Retina-sharp composite template `CGImage`-backed `NSImage` for the macOS menu bar
    /// without retaining any `drawingHandler` closures, strings, or font dictionaries.
    static func compositeMenuBarStrip(items: [(provider: String?, text: String)]) -> NSImage {
        return autoreleasepool {
            let font = NSFont.monospacedDigitSystemFont(ofSize: 12.0, weight: .medium)
            let textAttrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: NSColor.black,
            ]
            let iconSize: CGFloat = 13.5
            let iconTextGap: CGFloat = 3.5
            let groupGap: CGFloat = 9.5
            let barHeight: CGFloat = 18.0

            var segments: [(cgIcon: CGImage, text: NSString, textSize: NSSize)] = []
            segments.reserveCapacity(items.count)
            var totalWidth: CGFloat = 0

            for (index, item) in items.enumerated() {
                if index > 0 { totalWidth += groupGap }
                let iconKey = item.provider ?? "gauge"
                let cgIcon = iconEntry(for: iconKey, size: NSSize(width: iconSize, height: iconSize), isMenuBar: true).cgImage
                totalWidth += iconSize + (item.text.isEmpty ? 0 : iconTextGap)
                let ns = item.text as NSString
                let ts = item.text.isEmpty ? .zero : ns.size(withAttributes: textAttrs)
                totalWidth += ceil(ts.width)
                segments.append((cgIcon, ns, ts))
            }

            let finalSize = NSSize(width: max(16, totalWidth + 2), height: barHeight)
            let scale = backingScale
            let pxW = max(1, Int((finalSize.width * scale).rounded()))
            let pxH = max(1, Int((finalSize.height * scale).rounded()))
            let colorSpace = CGColorSpaceCreateDeviceRGB()

            guard let cgCtx = CGContext(
                data: nil,
                width: pxW,
                height: pxH,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else {
                return menuBarIcon()
            }

            cgCtx.scaleBy(x: scale, y: scale)
            let nsCtx = NSGraphicsContext(cgContext: cgCtx, flipped: false)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = nsCtx

            var x: CGFloat = 1.0
            for (index, seg) in segments.enumerated() {
                if index > 0 { x += groupGap }
                let iconY = ((finalSize.height - iconSize) / 2.0).rounded(.toNearestOrEven)
                cgCtx.draw(seg.cgIcon, in: CGRect(x: x, y: iconY, width: iconSize, height: iconSize))
                x += iconSize + (seg.text.length > 0 ? iconTextGap : 0)
                if seg.text.length > 0 {
                    let textY = ((finalSize.height - seg.textSize.height) / 2.0).rounded(.toNearestOrEven) - 0.5
                    seg.text.draw(at: NSPoint(x: x, y: textY), withAttributes: textAttrs)
                    x += ceil(seg.textSize.width)
                }
            }

            NSGraphicsContext.restoreGraphicsState()

            guard let outCG = cgCtx.makeImage() else {
                return menuBarIcon()
            }
            let strip = NSImage(cgImage: outCG, size: finalSize)
            strip.isTemplate = true
            return strip
        }
    }
}
