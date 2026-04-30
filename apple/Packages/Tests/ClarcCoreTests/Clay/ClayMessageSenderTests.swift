import Testing
import Foundation
@testable import ClarcCore

// Unit tests for the M8.5 input bar's outbound surface.

actor RecordingMessageSender: ClayMessageSender {
    struct Call: Equatable {
        var text: String?
        var images: [ClayImageAttachment]?
        var pastes: [String]?
        var clientMsgId: String?
    }
    private(set) var calls: [Call] = []

    func sendMessage(
        text: String?,
        images: [ClayImageAttachment]?,
        pastes: [String]?,
        clientMsgId: String?
    ) async throws {
        calls.append(.init(text: text, images: images, pastes: pastes, clientMsgId: clientMsgId))
    }
}

@Suite("ClayMessageSender dispatch")
struct ClayMessageSenderTests {

    @Test("plain text send round-trips")
    func plainText() async throws {
        let sender = RecordingMessageSender()
        try await sender.sendMessage(text: "hi", images: nil, pastes: nil, clientMsgId: "c-1")

        let calls = await sender.calls
        #expect(calls == [.init(text: "hi", images: nil, pastes: nil, clientMsgId: "c-1")])
    }

    @Test("wire encoding spot-check: c2s message JSON shape")
    func encodingShape() throws {
        let msg = ClayOutbound.message(
            text: "hello",
            images: nil,
            pastes: nil,
            clientMsgId: "c-42"
        )
        let data = try JSONEncoder().encode(msg)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        #expect(json["type"] as? String == "message")
        #expect(json["text"] as? String == "hello")
        #expect(json["clientMsgId"] as? String == "c-42")
    }
}
