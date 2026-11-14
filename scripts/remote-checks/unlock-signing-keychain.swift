// Used only by an explicitly opted-in, owned packaged test build. Password bytes
// arrive on an anonymous pipe, never in arguments, environment, logs or files.
import Foundation
import Security

let interactionStatus = SecKeychainSetUserInteractionAllowed(false)
guard interactionStatus == errSecSuccess else {
    fputs("Could not disable signing keychain interaction (OSStatus \(interactionStatus))\n", stderr)
    exit(1)
}
var password = Data()
while password.count <= 4096 {
    let part = FileHandle.standardInput.readData(ofLength: 4097 - password.count)
    if part.isEmpty { break }
    password.append(part)
}
guard !password.isEmpty && password.count <= 4096 else {
    password.resetBytes(in: 0..<password.count)
    fputs("Signing password pipe must contain 1 to 4096 bytes\n", stderr)
    exit(1)
}
var keychain: SecKeychain?
let opened = SecKeychainCopyDefault(&keychain)
let status: OSStatus
if opened == errSecSuccess {
    status = password.withUnsafeBytes { bytes in
        SecKeychainUnlock(keychain, UInt32(password.count), bytes.baseAddress, true)
    }
} else { status = opened }
password.resetBytes(in: 0..<password.count)
guard status == errSecSuccess else {
    fputs("Noninteractive signing keychain unlock failed (OSStatus \(status))\n", stderr)
    exit(1)
}
print("[dev app] signing keychain unlocked for this build session")
