import PhotosUI
import SwiftUI
import UIKit

/// The camera, for a receipt at the till.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

enum ReceiptImage {
    /// A JPEG the receipt reader accepts (iPhone photos are often HEIC), at most `maxSide` pixels on its long side.
    static func jpeg(_ image: UIImage, maxSide: CGFloat = 2000) -> Data? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let scale = min(1, maxSide / longest)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return resized.jpegData(compressionQuality: 0.7)
    }
}

/// Adds a receipt from the camera or the photo library, and tells you what was read.
struct ReceiptCapture: ViewModifier {
    @EnvironmentObject private var ledger: Ledger
    @Binding var pickPhoto: Bool
    @Binding var takePhoto: Bool
    @State private var item: PhotosPickerItem?
    @State private var busy = false
    @State private var message: String?
    @State private var error: String?

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: $pickPhoto, selection: $item, matching: .images)
            .fullScreenCover(isPresented: $takePhoto) {
                CameraPicker { image in send(image) }.ignoresSafeArea()
            }
            .onChange(of: item) { _, picked in
                guard let picked else { return }
                Task {
                    if let data = try? await picked.loadTransferable(type: Data.self), let image = UIImage(data: data) { send(image) }
                    item = nil
                }
            }
            .overlay {
                if busy {
                    VStack(spacing: 8) {
                        ProgressView()
                        Text("Reading the receipt").font(.caption)
                    }
                    .padding(16)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .alert("Receipt", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("OK", role: .cancel) { message = nil }
            } message: {
                Text(message ?? "")
            }
            .errorAlert($error)
    }

    private func send(_ image: UIImage) {
        guard let data = ReceiptImage.jpeg(image) else { return }
        busy = true
        Task {
            do { message = try await ledger.addReceipt(data, contentType: "image/jpeg", fileExtension: "jpg") } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

extension View {
    func receiptCapture(pickPhoto: Binding<Bool>, takePhoto: Binding<Bool>) -> some View {
        modifier(ReceiptCapture(pickPhoto: pickPhoto, takePhoto: takePhoto))
    }
}

/// True when this phone has a camera (not in the simulator).
@MainActor var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
