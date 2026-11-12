// A protocol double with real child-process streams and no external requests.
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const home = process.argv[2];
const mode = process.argv[3];
let loggedIn = fs.existsSync(path.join(home, "auth.json"));
let initialized = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialized") {
    initialized = true;
    return;
  }
  const result = (value) => send({ id: request.id, result: value });
  if (mode === "hang") return;
  if (mode === "exit") {
    process.exit(1);
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  if (request.method === "initialize") {
    result({});
    return;
  }
  if (!initialized) {
    send({ id: request.id, error: { message: "not initialized" } });
    return;
  }
  switch (request.method) {
    case "account/read":
      result({ account: loggedIn ? { type: "chatgpt", planType: "pro" } : null });
      break;
    case "account/login/start": {
      const loginId = "login-1";
      const value =
        request.params.type === "chatgptDeviceCode"
          ? {
              loginId,
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-TEST",
            }
          : {
              loginId,
              authUrl: "https://auth.openai.com/oauth/authorize?state=test",
            };
      if (mode === "pending") result(value);
      else {
        loggedIn = mode !== "login-error";
        if (loggedIn)
          fs.writeFileSync(path.join(home, "auth.json"), '{"test":true}', {
            mode: 0o600,
          });
        // Deliberately deliver completion in the same chunk as the login reply.
        process.stdout.write(
          JSON.stringify({ id: request.id, result: value }) +
            "\n" +
            JSON.stringify({
              method: "account/login/completed",
              params: {
                loginId,
                success: loggedIn,
                error: "PRIVATE-RAW-ERROR",
              },
            }) +
            "\n",
        );
      }
      break;
    }
    case "account/login/cancel":
      result({});
      break;
    case "account/logout":
      loggedIn = false;
      fs.rmSync(path.join(home, "auth.json"), { force: true });
      result({});
      break;
    case "thread/start":
      if (
        request.params.ephemeral !== true ||
        request.params.sandbox !== "read-only" ||
        request.params.approvalPolicy !== "never" ||
        request.params.config.features.shell_tool !== false
      ) {
        send({ id: request.id, error: { message: "unsafe test setup" } });
      } else result({ thread: { id: "test-thread" } });
      break;
    case "turn/start": {
      if (request.params.input[0].text !== "Reply with OK.") {
        send({ id: request.id, error: { message: "wrong prompt" } });
        break;
      }
      const events = [
        { id: request.id, result: { turn: { id: "test-turn" } } },
      ];
      if (mode === "test-exit") {
        process.exit(1);
        break;
      }
      if (mode === "test-malformed") {
        process.stdout.write("invalid\n");
        break;
      }
      if (mode === "test-hang") {
        result({ turn: { id: "test-turn" } });
        break;
      }
      if (mode === "test-tool")
        events.push({
          method: "item/started",
          params: {
            threadId: "test-thread",
            item: { type: "commandExecution" },
          },
        });
      else if (mode === "test-approval")
        events.push({
          id: 999,
          method: "item/commandExecution/requestApproval",
          params: {},
        });
      else {
        events.push({
          method: "item/completed",
          params: {
            threadId: "test-thread",
            item: {
              type: "agentMessage",
              text: mode === "test-empty" ? "" : "OK",
            },
          },
        });
        events.push({
          method: "turn/completed",
          params: {
            threadId: "test-thread",
            turn: {
              id: "test-turn",
              status: mode === "test-failed" ? "failed" : "completed",
            },
          },
        });
      }
      process.stdout.write(
        events.map((value) => JSON.stringify(value)).join("\n") + "\n",
      );
      break;
    }
    case "account/rateLimits/read": {
      const file = path.join(home, "usage-response.json");
      if (mode === "usage-hang") break;
      if (mode === "usage-error") { send({ id: request.id, error: { message: "PRIVATE-USAGE-ERROR" } }); break; }
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {
        rateLimits: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 2000600000 }, credits: { balance: "123.45", hasCredits: true, unlimited: false } },
        rateLimitResetCredits: { availableCount: 2, credits: request.params.excludeResetCreditDetails ? null : [{ id: "reset-1", resetType: "codexRateLimits", status: "available", grantedAt: 1700000000, expiresAt: 2000000000, title: "Earned reset" }] },
      };
      if (mode === "usage-notification") send({ method: "account/rateLimits/updated", params: { rateLimits: {} } });
      result(data);
      break;
    }
    case "account/rateLimitResetCredit/consume": {
      const file = path.join(home, "reset-attempts.json");
      const keys = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
      const duplicate = keys.includes(request.params.idempotencyKey);
      keys.push(request.params.idempotencyKey);
      fs.writeFileSync(file, JSON.stringify(keys));
      result({ outcome: duplicate ? "alreadyRedeemed" : mode === "reset-empty" ? "nothingToReset" : mode === "reset-none" ? "noCredit" : "reset" });
      break;
    }
    case "model/list":
      result(
        request.params.cursor
          ? {
              data: [{ model: "second", displayName: "Second" }],
              nextCursor: null,
            }
          : {
              data: [
                { model: "first", displayName: "First" },
                { model: "hidden", hidden: true },
              ],
              nextCursor: "page-2",
            },
      );
      break;
    default:
      send({ id: request.id, error: { message: "PRIVATE-RAW-ERROR" } });
  }
});
