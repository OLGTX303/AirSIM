import SwiftUI

/// AirSIM 只引导 Air8000 配对；不检查旧模块 USB ECM、AT 或 QDC507 固件。
struct AirSIMFirstConnectionView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("airsim.first-connection-complete") private var completed = false
    @State private var showingPairing = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: "iphone.radiowaves.left.and.right")
                    .font(.system(size: 42, weight: .medium))
                    .foregroundStyle(.blue)
                    .frame(width: 76, height: 76)
                    .background(.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 22))

                VStack(alignment: .leading, spacing: 8) {
                    Text(L10n.t("连接 Air8000"))
                        .font(.largeTitle.bold())
                    Text(L10n.t("AirSIM 通过同一 Wi-Fi 或 Air8000 热点建立 VoWLAN；离开局域网时可使用独立云端 Relay。"))
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 18) {
                    Label(L10n.t("在 Air8000 启动 AirSIM 和音频桥"), systemImage: "1.circle.fill")
                    Label(L10n.t("将两台设备连接到同一局域网"), systemImage: "2.circle.fill")
                    Label(L10n.t("输入 Air8000 显示的六位配对码"), systemImage: "3.circle.fill")
                }
                .font(.body.weight(.medium))
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))

                Spacer()

                Button(L10n.t("开始配对"), systemImage: "lock.shield") {
                    showingPairing = true
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)

                Button(L10n.t("稍后在设置中配对")) { completed = true }
                    .frame(maxWidth: .infinity)
            }
            .padding(24)
            .navigationTitle("AirSIM")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showingPairing, onDismiss: {
                if model.vowlan.availability.isOnlineForDisplay { completed = true }
            }) {
                NavigationStack {
                    SamsungPairingView()
                        .environmentObject(model)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button(L10n.t("完成")) { showingPairing = false }
                            }
                        }
                }
            }
        }
    }
}

struct AirSIMSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: AppSettings
    @AppStorage(CloudModePreference.key) private var cloudModeEnabled = true
    @State private var relayURL = UserDefaults.standard.string(forKey: "airsim.push-relay-url") ?? ""
    @State private var message: String?
    @FocusState private var relayFieldFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section(L10n.t("Air8000 连接")) {
                    LabeledContent("VoWLAN", value: VoWLANStatusCopy.text(for: model.vowlan.availability))
                    NavigationLink {
                        SamsungPairingView()
                    } label: {
                        Label(L10n.t("配对 Air8000"), systemImage: "personalhotspot")
                    }
                    Button(L10n.t("重新发现"), systemImage: "arrow.clockwise") {
                        model.vowlan.restartBrowsing()
                        Task { await model.vowlan.probeNow() }
                    }
                }

                Section {
                    Toggle(isOn: $cloudModeEnabled) {
                        Label(L10n.t("远程通话与短信"), systemImage: "cloud")
                    }
                    .onChange(of: cloudModeEnabled) { enabled in
                        Task {
                            if let (api, _) = await model.readyVoWLANRoute() {
                                await VoIPPushController.shared.setCloudModeEnabled(enabled, with: api)
                            }
                        }
                    }

                    TextField("https://relay.example.com", text: $relayURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($relayFieldFocused)
                        .submitLabel(.done)
                        .onSubmit { relayFieldFocused = false }
                    Button(L10n.t("保存 Relay 地址")) {
                        relayFieldFocused = false
                        VoIPPushController.shared.updateRelayURL(relayURL)
                        Task {
                            if let (api, _) = await model.readyVoWLANRoute() {
                                await VoIPPushController.shared.syncRegistration(with: api)
                            }
                        }
                        message = L10n.t("地址已保存；配对后自动注册。")
                    }
                    if let message { Text(message).foregroundStyle(.secondary) }
                } header: {
                    Text(L10n.t("云端 Relay"))
                } footer: {
                    Text(L10n.t("云端关闭后，局域网内的 Air8000 VoWLAN 仍可使用；公网拨打、接听和短信需要云端 Relay 与有效设备注册。"))
                }

                Section(L10n.t("关于")) {
                    LabeledContent(L10n.t("项目"), value: "AirSIM · Air8000")
                    Picker(L10n.t("外观"), selection: $settings.appearance) {
                        ForEach(AppAppearance.allCases) { appearance in
                            Text(appearance.title).tag(appearance)
                        }
                    }
                    Picker(L10n.t("语言"), selection: $settings.language) {
                        ForEach(AppLanguage.allCases) { language in
                            Text(language.title).tag(language)
                        }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button(L10n.t("完成")) { relayFieldFocused = false }
                }
            }
            .navigationTitle(L10n.t("设置"))
        }
    }
}
