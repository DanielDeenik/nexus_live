import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var backend: Backend
    @State private var email = ""
    @State private var password = ""
    @State private var codeSent = false
    @State private var code = ""
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
                Section(header: Text("Password"), footer: Text("Sign in once with your password or the email code. From then on Face ID unlocks the app and signs you back in.")) {
                    SecureField("Password", text: $password).textContentType(.password)
                    Button("Sign in") { run { try await backend.signIn(email: email, password: password) } }
                        .disabled(email.isEmpty || password.isEmpty || busy)
                }
                Section(header: Text("Or sign in by email"),
                        footer: Text("Tap Email me a code and type the 6 digit code from the email. Do not tap or press and hold the link in the email: that uses it up on the website.")) {
                    if codeSent {
                        TextField("6 digit code", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                        Button("Sign in with code") { run { try await backend.verifyCode(email: email, code: code) } }
                            .disabled(code.count < 6 || busy)
                    }
                    Button(codeSent ? "Send a new code" : "Email me a code") {
                        run {
                            try await backend.sendCode(email: email)
                            codeSent = true
                        }
                    }
                    .disabled(email.isEmpty || busy)
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
