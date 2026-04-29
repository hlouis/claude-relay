import Foundation

// MARK: - AskUserQuestion

/// Parsed input payload for the `AskUserQuestion` tool.
///
/// The CLI emits a tool_use event whose `input` looks like:
/// ```json
/// {
///   "questions": [
///     {
///       "question": "...",
///       "header": "...",
///       "multiSelect": false,
///       "options": [
///         {"label": "A", "description": "..."},
///         {"label": "B", "description": "..."}
///       ]
///     }
///   ]
/// }
/// ```
public struct AskUserQuestion: Sendable, Equatable {
    public struct Question: Sendable, Equatable, Identifiable {
        public let id: String
        public let question: String
        public let header: String?
        public let multiSelect: Bool
        public let options: [Option]

        public init(id: String, question: String, header: String?, multiSelect: Bool, options: [Option]) {
            self.id = id
            self.question = question
            self.header = header
            self.multiSelect = multiSelect
            self.options = options
        }
    }

    public struct Option: Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String
        public let description: String?

        public init(label: String, description: String?) {
            self.id = label
            self.label = label
            self.description = description
        }
    }

    public let questions: [Question]

    public init(questions: [Question]) {
        self.questions = questions
    }

    /// Decode from the raw `[String: JSONValue]` tool-use input.
    /// Returns nil if the payload is not shaped like an AskUserQuestion input.
    public init?(input: [String: JSONValue]) {
        guard let rawQuestions = input["questions"]?.arrayValue else { return nil }

        let parsed: [Question] = rawQuestions.enumerated().compactMap { idx, entry in
            guard let obj = entry.objectValue,
                  let question = obj["question"]?.stringValue else { return nil }

            let options: [Option] = (obj["options"]?.arrayValue ?? []).compactMap { opt in
                guard let optObj = opt.objectValue,
                      let label = optObj["label"]?.stringValue else { return nil }
                return Option(label: label, description: optObj["description"]?.stringValue)
            }

            return Question(
                id: "q\(idx)",
                question: question,
                header: obj["header"]?.stringValue,
                multiSelect: obj["multiSelect"]?.boolValue ?? false,
                options: options
            )
        }

        guard !parsed.isEmpty else { return nil }
        self.questions = parsed
    }
}
