import SwiftUI
import UIKit

struct SignInView: View {
    @EnvironmentObject private var backend: Backend
    @State private var email = ""
    @State private var password = ""
    @State private var codeSent = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if backend.hasFaceIDSignIn {
                    Section {
                        Button {
                            run { try await backend.signInWithFaceID() }
                        } label: {
                            Label("Sign in with Face ID", systemImage: "faceid").bold()
                        }
                        .disabled(busy)
                    }
                }
                Section {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section(header: Text("Password"), footer: Text("Sign in once with your password or the email link. From then on Face ID unlocks the app and signs you back in.")) {
                    SecureField("Password", text: $password).textContentType(.password)
                    Button("Sign in") { run { try await backend.signIn(email: email, password: password) } }
                        .disabled(email.isEmpty || password.isEmpty || busy)
                }
                Section(header: Text("Or a sign in link by email"),
                        footer: Text("Tap Email me a link. In the email, press and hold Sign in, tap Copy Link, then tap Paste sign in link here. Do not tap the link itself: it opens the website.")) {
                    Button("Email me a link") {
                        run {
                            try await backend.sendCode(email: email)
                            codeSent = true
                        }
                    }
                    .disabled(email.isEmpty || busy)
                    Button("Paste sign in link") {
                        let copied = UIPasteboard.general.string ?? ""
                        run { try await backend.signInWithLink(copied) }
                    }
                    .disabled(busy)
                }
            }
            .navigationTitle("Nexuslive")
            .overlay { if busy { ProgressView() } }
            .errorAlert($error)
            .onAppear {
                if backend.hasFaceIDSignIn && !busy { run { try await backend.signInWithFaceID() } }
            }
        }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        Task {
            do { try await work() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}
