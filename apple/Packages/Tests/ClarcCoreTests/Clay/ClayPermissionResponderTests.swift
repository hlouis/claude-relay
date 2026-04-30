import Testing
import Foundation
@testable import ClarcCore

// Unit tests for the M5 permission decision flow. The view layer is
// not part of the SPM package; these tests cover the protocol +
// helper logic that the view will compose.

// MARK: - Mock

/// Records every `sendPermissionResponse` call. Implemented as an
/// actor — async access is the natural way to satisfy the protocol's
/// `async throws` signature without manual locking.
actor RecordingPermissionResponder: ClayPermissionResponder {
    struct Call: Equatable {
        var requestId: String
        var decision: ClayPermissionDecision
        var updatedInput: ClayToolInput?
        var planContent: String?
    }

    private(set) var calls: [Call] = []

    func sendPermissionResponse(
        requestId: String,
        decision: ClayPermissionDecision,
        updatedInput: ClayToolInput?,
        planContent: String?
    ) async throws {
        calls.append(.init(
            requestId: requestId,
            decision: decision,
            updatedInput: updatedInput,
            planContent: planContent
        ))
    }
}

// MARK: - Helpers

private func makeItem(
    requestId: String = "p-1",
    toolName: String = "Bash",
    toolInput: ClayToolInput = ["cmd": .string("ls")],
    decisionReason: String = ""
) -> ClayChatItem.PermissionItem {
    .init(
        id: requestId,
        toolName: toolName,
        toolInput: toolInput,
        toolUseId: "u-\(requestId)",
        decisionReason: decisionReason
    )
}

// MARK: - Plan-tool detection

@Suite("ClayPermissionItem.isPlanTool")
struct ClayPermissionItemPlanToolTests {

    @Test("ExitPlanMode is the plan tool")
    func exitPlanModeIsPlanTool() {
        #expect(makeItem(toolName: "ExitPlanMode").isPlanTool == true)
    }

    @Test("EnterPlanMode is NOT the plan tool — daemon never asks permission for it")
    func enterPlanModeIsNotPlanTool() {
        #expect(makeItem(toolName: "EnterPlanMode").isPlanTool == false)
    }

    @Test("generic tools are not plan tools")
    func genericToolsAreNotPlan() {
        for name in ["Bash", "Write", "Edit", "Read", "Task"] {
            #expect(makeItem(toolName: name).isPlanTool == false, "tool \(name)")
        }
    }
}

// MARK: - Decision dispatch

@Suite("ClayPermissionResponder dispatch")
struct ClayPermissionResponderDispatchTests {

    @Test("generic tool: allow / allowAlways / deny round-trip the right decision strings")
    func genericThreeButtons() async throws {
        let responder = RecordingPermissionResponder()
        let item = makeItem(toolName: "Bash")

        for decision: ClayPermissionDecision in [.allow, .allowAlways, .deny] {
            try await responder.sendPermissionResponse(
                requestId: item.id,
                decision: decision,
                updatedInput: nil,
                planContent: nil
            )
        }

        let calls = await responder.calls
        #expect(calls.count == 3)
        #expect(calls[0].decision == .allow)
        #expect(calls[1].decision == .allowAlways)
        #expect(calls[2].decision == .deny)
        #expect(calls.allSatisfy { $0.requestId == "p-1" })
        #expect(calls.allSatisfy { $0.updatedInput == nil && $0.planContent == nil })
    }

    @Test("plan tool: all four plan-mode decisions are valid and carry no planContent (daemon falls back to planFilePath)")
    func planFourButtons() async throws {
        let responder = RecordingPermissionResponder()
        let item = makeItem(
            requestId: "p-plan",
            toolName: "ExitPlanMode",
            toolInput: ["plan": .string("step 1\nstep 2"), "planFilePath": .string("/tmp/plan.md")]
        )
        #expect(item.isPlanTool == true)

        let decisions: [ClayPermissionDecision] = [.allowClearContext, .allowAcceptEdits, .allow, .deny]
        for decision in decisions {
            try await responder.sendPermissionResponse(
                requestId: item.id,
                decision: decision,
                updatedInput: nil,
                planContent: nil
            )
        }

        let calls = await responder.calls
        #expect(calls.map(\.decision) == decisions)
        #expect(calls.allSatisfy { $0.requestId == "p-plan" })
        // planContent stitching is a Phase 2 feature — daemon's
        // planFilePath fallback handles allow_clear_context for now.
        #expect(calls.allSatisfy { $0.planContent == nil })
    }

    @Test("wire encoding matches c2s permission_response fixture shape")
    func encodingShape() throws {
        // Spot-check that the decision strings the responder forwards
        // match what ClayOutbound emits on the wire — guards against
        // an enum rename drifting away from the daemon's vocabulary.
        let cases: [(ClayPermissionDecision, String)] = [
            (.allow,             "allow"),
            (.allowAlways,       "allow_always"),
            (.deny,              "deny"),
            (.allowAcceptEdits,  "allow_accept_edits"),
            (.allowClearContext, "allow_clear_context"),
        ]
        let encoder = JSONEncoder()
        for (decision, wire) in cases {
            let msg = ClayOutbound.permissionResponse(
                requestId: "p-1",
                decision: decision,
                updatedInput: nil,
                planContent: nil
            )
            let data = try encoder.encode(msg)
            let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            #expect(json["type"] as? String == "permission_response")
            #expect(json["decision"] as? String == wire, "decision \(decision)")
            #expect(json["requestId"] as? String == "p-1")
        }
    }
}
