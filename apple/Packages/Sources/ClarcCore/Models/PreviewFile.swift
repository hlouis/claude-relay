import Foundation

public struct PreviewFile: Identifiable, Sendable {
    public struct EditHunk: Sendable, Equatable {
        public let oldString: String
        public let newString: String

        public init(oldString: String, newString: String) {
            self.oldString = oldString
            self.newString = newString
        }
    }

    public let id = UUID()
    public let path: String
    public let name: String
    public let editHunks: [EditHunk]

    public init(path: String, name: String, editHunks: [EditHunk] = []) {
        self.path = path
        self.name = name
        self.editHunks = editHunks
    }
}
