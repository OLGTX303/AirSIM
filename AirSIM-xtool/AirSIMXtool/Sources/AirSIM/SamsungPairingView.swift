import SwiftUI

struct SamsungPairingView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var browser = SamsungPairingBrowser()
    @State private var code = ""
    @State private var pairingServiceID: String?
    @State private var message = ""
    @FocusState private var codeFieldFocused: Bool

    var body: some View {
        Form {
            Section(L10n.t("连接步骤")) {
                Label(L10n.t("让 Air8000 与本机连接同一 Wi-Fi"), systemImage: "wifi")
                Label(L10n.t("也可让本机连接 Air8000 移动热点"), systemImage: "personalhotspot")
                Label(L10n.t("在 Air8000 App 点击“开始一次性配对”"), systemImage: "key")
            }

            Section(L10n.t("发现的设备")) {
                if browser.services.isEmpty {
                    HStack {
                        ProgressView()
                        Text(browser.stateText).foregroundStyle(.secondary)
                    }
                }
                ForEach(browser.services) { service in
                    VStack(alignment: .leading, spacing: 10) {
                        Label(service.displayName, systemImage: "iphone.radiowaves.left.and.right")
                            .font(.headline)
                        TextField(L10n.t("Air8000 显示的 6 位验证码"), text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .focused($codeFieldFocused)
                            .onChange(of: code) { value in
                                code = String(value.filter(\.isNumber).prefix(6))
                            }
                        Button(L10n.t("加密配对"), systemImage: "lock.shield") {
                            codeFieldFocused = false
                            Task { await pair(service) }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(code.count != 6 || pairingServiceID != nil)
                    }
                    .padding(.vertical, 4)
                }
            }

            if !message.isEmpty {
                Section(L10n.t("结果")) { Text(message) }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(L10n.t("完成")) { codeFieldFocused = false }
            }
        }
        .navigationTitle(L10n.t("配对 Air8000"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { browser.start() }
        .onDisappear { browser.stop() }
    }

    @MainActor
    private func pair(_ service: SamsungPairingService) async {
        pairingServiceID = service.id
        message = L10n.t("正在加密并写入 Linux Agent…")
#if DEBUG
        print("[AirSIM Pair] claim_started session=\(service.sessionID)")
#endif
        defer { pairingServiceID = nil }
        do {
            guard let registration = VoIPPushController.shared.pairingRegistration() else {
                throw SamsungPairingClientError.registrationUnavailable
            }
            message = try await SamsungPairingCompletionCoordinator.complete(
                performPairing: {
                    try await SamsungPairingClient.pair(
                        service: service,
                        code: code,
                        registration: registration
                    )
                },
                refreshVoWLAN: {
                    await model.vowlan.refreshAfterPairing()
                }
            )
#if DEBUG
            print("[AirSIM Pair] claim_completed session=\(service.sessionID)")
#endif
        } catch {
            message = "\(L10n.t("配对失败："))\(error.localizedDescription)"
#if DEBUG
            print("[AirSIM Pair] claim_failed session=\(service.sessionID) error=\(String(describing: type(of: error)))")
#endif
        }
    }
}
