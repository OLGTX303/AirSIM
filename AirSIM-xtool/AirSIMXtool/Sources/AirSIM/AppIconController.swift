import SwiftUI
import UIKit

/// Keeps the home-screen icon in step with the app's effective appearance.
///
/// xtool can't compile an Assets.car with dark/tinted icon appearances, so the
/// dark icon ships as a loose-PNG alternate icon (see AirSIM-Info.plist) and is
/// swapped here. ponytail: iOS shows a system alert on every swap and can only
/// swap while the app is open; a Mac-built Assets.car with a dark appearance
/// would make the switch automatic and silent.
@MainActor
enum AppIconController {
    static let darkIconName = "AppIconDark"

    static func match(_ scheme: ColorScheme) {
        let app = UIApplication.shared
        guard app.supportsAlternateIcons, app.applicationState == .active else { return }
        let wanted: String? = scheme == .dark ? darkIconName : nil
        guard app.alternateIconName != wanted else { return }
        app.setAlternateIconName(wanted) { error in
            if let error { print("[AirSIM Icon] switch failed: \(error.localizedDescription)") }
        }
    }
}
