// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AirSIMXtool",
    platforms: [
        // SwiftPM's platform declaration only supports whole iOS versions;
        // the Live Activity APIs used by AirSIM require iOS 16.1+.
        .iOS(.v17),
    ],
    products: [
        .library(
            name: "AirSIMXtool",
            targets: ["AirSIM"]
        ),
    ],
    targets: [
        .target(
            name: "AirSIM",
            path: "Sources/AirSIM",
            linkerSettings: [
                // ponytail: xtool on Linux stamps LC_BUILD_VERSION sdk = deployment
                // target (17.0), so iOS runs the app in compatibility mode with no
                // Liquid Glass. lld takes the last -platform_version; bump 26.0 if
                // the xtool SDK is newer.
                .unsafeFlags([
                    "-Xlinker", "-platform_version",
                    "-Xlinker", "ios",
                    "-Xlinker", "17.0",
                    "-Xlinker", "26.0",
                ]),
            ]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
