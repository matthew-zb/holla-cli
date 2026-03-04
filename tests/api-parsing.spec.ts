import { vi, beforeEach } from "vitest"

const mockApiCall = vi.fn().mockResolvedValue({ ok: true })
const mockResolveChannel = vi.fn().mockResolvedValue("C_RESOLVED")
let mockExit: ReturnType<typeof vi.fn>

vi.mock("../src/lib/credentials.ts", () => ({
	getToken: vi.fn().mockResolvedValue({ token: "xoxp-test", workspace: "test-ws" }),
}))

vi.mock("../src/platforms/slack/client.ts", () => ({
	createSlackClient: vi.fn(() => ({
		apiCall: (...args: unknown[]) => mockApiCall(...args),
	})),
}))

vi.mock("../src/platforms/slack/resolve.ts", () => ({
	resolveChannel: (...args: unknown[]) => mockResolveChannel(...args),
}))

beforeEach(() => {
	mockApiCall.mockClear().mockResolvedValue({ ok: true })
	mockResolveChannel.mockClear().mockResolvedValue("C_RESOLVED")
	mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
		throw new Error("process.exit")
	}) as any)
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

async function runApi(argv: string[]) {
	process.argv = ["node", "holla", "slack", ...argv]
	const { apiCommand } = await import("../src/platforms/slack/api.ts")
	await (apiCommand as any).run({ args: { workspace: "test-ws" } })
}

describe("api command parsing", () => {
	it("should extract method name as first non-flag argument", async () => {
		await runApi(["api", "users.list"])
		expect(mockApiCall).toHaveBeenCalledWith("users.list", {})
	})

	it("should parse --body JSON flag", async () => {
		await runApi(["api", "users.list", "--body", '{"limit":100}'])
		expect(mockApiCall).toHaveBeenCalledWith("users.list", { limit: 100 })
	})

	it("should parse positional JSON body (regression: was silently ignored)", async () => {
		await runApi(["api", "users.list", '{"limit":1000}'])
		expect(mockApiCall).toHaveBeenCalledWith("users.list", { limit: 1000 })
	})

	it("should prefer --body over positional JSON", async () => {
		await runApi(["api", "users.list", "--body", '{"limit":50}', '{"limit":100}'])
		expect(mockApiCall).toHaveBeenCalledWith("users.list", { limit: 50 })
	})

	it("should convert --kebab-case flags to camelCase", async () => {
		await runApi(["api", "channels.list", "--exclude-archived", "true"])
		expect(mockApiCall).toHaveBeenCalledWith("channels.list", { excludeArchived: "true" })
	})

	it("should treat --flag without value as boolean true", async () => {
		await runApi(["api", "channels.list", "--exclude-archived"])
		expect(mockApiCall).toHaveBeenCalledWith("channels.list", { excludeArchived: true })
	})

	it("should skip --workspace and its value after method from API args", async () => {
		await runApi(["api", "users.list", "--workspace", "my-ws", "--limit", "50"])
		expect(mockApiCall).toHaveBeenCalledWith("users.list", { limit: "50" })
	})

	it("should skip -w alias and its value after method from API args", async () => {
		await runApi(["api", "users.list", "-w", "my-ws"])
		expect(mockApiCall).toHaveBeenCalledWith("users.list", {})
	})

	it("should exit with code 1 when no method is provided", async () => {
		await expect(runApi(["api"])).rejects.toThrow("process.exit")
		expect(mockExit).toHaveBeenCalledWith(1)
	})

	it("should exit with code 1 for invalid --body JSON", async () => {
		await expect(runApi(["api", "users.list", "--body", "not-json"])).rejects.toThrow("process.exit")
		expect(mockExit).toHaveBeenCalledWith(1)
	})

	it("should exit with code 1 for invalid positional JSON", async () => {
		await expect(runApi(["api", "users.list", "{not-json}"])).rejects.toThrow("process.exit")
		expect(mockExit).toHaveBeenCalledWith(1)
	})

	it("should warn when using chat.postMessage via api", async () => {
		await runApi(["api", "chat.postMessage", "--body", '{"channel":"C123","text":"hi"}'])
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("holla slack chat send"))
	})

	it("should warn when using chat.update via api", async () => {
		await runApi(["api", "chat.update", "--body", '{"channel":"C123","ts":"1","text":"hi"}'])
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("holla slack chat edit"))
	})

	it("should not warn for read-only api methods", async () => {
		await runApi(["api", "users.list"])
		expect(console.error).not.toHaveBeenCalled()
	})

	it("should handle complex nested JSON body", async () => {
		await runApi(["api", "chat.postMessage", "--body", '{"channel":"C123","blocks":[{"type":"section"}]}'])
		expect(mockApiCall).toHaveBeenCalledWith("chat.postMessage", {
			channel: "C123",
			blocks: [{ type: "section" }],
		})
	})
})

describe("api channel auto-resolve", () => {
	it("should resolve bare channel name to ID", async () => {
		await runApi(["api", "conversations.history", "--channel", "general"])
		expect(mockResolveChannel).toHaveBeenCalledWith(expect.anything(), "#general", "test-ws")
		expect(mockApiCall).toHaveBeenCalledWith("conversations.history", { channel: "C_RESOLVED" })
	})

	it("should resolve #-prefixed channel name to ID", async () => {
		await runApi(["api", "conversations.history", "--body", '{"channel":"#general"}'])
		expect(mockResolveChannel).toHaveBeenCalledWith(expect.anything(), "#general", "test-ws")
		expect(mockApiCall).toHaveBeenCalledWith("conversations.history", { channel: "C_RESOLVED" })
	})

	it("should pass through channel IDs starting with C", async () => {
		await runApi(["api", "conversations.history", "--channel", "C01234567"])
		expect(mockResolveChannel).not.toHaveBeenCalled()
		expect(mockApiCall).toHaveBeenCalledWith("conversations.history", { channel: "C01234567" })
	})

	it("should pass through DM IDs starting with D", async () => {
		await runApi(["api", "conversations.history", "--channel", "D01234567"])
		expect(mockResolveChannel).not.toHaveBeenCalled()
		expect(mockApiCall).toHaveBeenCalledWith("conversations.history", { channel: "D01234567" })
	})

	it("should pass through group DM IDs starting with G", async () => {
		await runApi(["api", "conversations.history", "--channel", "G01234567"])
		expect(mockResolveChannel).not.toHaveBeenCalled()
		expect(mockApiCall).toHaveBeenCalledWith("conversations.history", { channel: "G01234567" })
	})

	it("should not resolve when no channel field is present", async () => {
		await runApi(["api", "users.list", "--limit", "100"])
		expect(mockResolveChannel).not.toHaveBeenCalled()
	})
})
