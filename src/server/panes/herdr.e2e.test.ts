/**
 * Opt-in: EXCALIAGENT_E2E_HERDR=1 npx vitest run src/server/panes
 * Starts a throwaway herdr server (temp HOME + socket), runs a dummy process
 * in a pane, and checks pid → pane matching. Never touches a real session.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHerdrLink } from "./herdr.ts";
import { herdrRequest } from "./herdr-client.ts";
import { startIsolatedHerdr, type IsolatedHerdr } from "./__fixtures__/isolated-herdr.ts";
import { waitFor } from "./__fixtures__/test-util.ts";

const enabled = process.env.EXCALIAGENT_E2E_HERDR === "1";

describe.skipIf(!enabled)("herdr e2e (isolated server)", () => {
  let herdr: IsolatedHerdr;
  beforeAll(async () => {
    herdr = await startIsolatedHerdr();
  });
  afterAll(async () => {
    await herdr?.stop();
  });

  it("maps a dummy foreground process to its pane, and follows a new pane", async () => {
    const link = createHerdrLink({ socketPath: herdr.socketPath, resyncMs: 60_000, retryMinMs: 20 });
    try {
      await waitFor(() => link.available(), 5000, "link connected");
      const ws = (await herdrRequest(herdr.socketPath, "workspace.create", {
        cwd: herdr.dir,
        label: "e2e-ws",
        focus: false,
      })) as { root_pane?: { pane_id: string }; tab: { tab_id: string } };
      const paneId = ws.root_pane?.pane_id ?? "w1:p1";

      // A child sh records its own pid, then execs sleep: the sleep process
      // keeps that pid and is the pane's foreground process.
      const pidFile = join(herdr.dir, "dummy.pid");
      await herdrRequest(herdr.socketPath, "pane.send_text", {
        pane_id: paneId,
        text: `sh -c 'echo $$ > ${pidFile}; exec sleep 300'\n`,
      });
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 5000, "pid file");
      const pid = Number(readFileSync(pidFile, "utf8").trim());

      await link.refresh();
      await waitFor(() => link.match(pid) !== undefined, 5000, "pid matched");
      expect(link.match(pid)).toMatchObject({ paneId, workspaceId: paneId.split(":")[0], workspaceLabel: "e2e-ws" });

      // Renaming the tab reaches the card label via the tab_renamed event.
      await herdrRequest(herdr.socketPath, "tab.rename", { tab_id: ws.tab.tab_id, label: "renamed by e2e" });
      await waitFor(() => link.match(pid)?.tabLabel === "renamed by e2e", 5000, "tab label follows rename");

      // A new pane with its own dummy process.
      const split = (await herdrRequest(herdr.socketPath, "pane.split", {
        target_pane_id: paneId,
        direction: "right",
        focus: false,
      })) as { pane: { pane_id: string } };
      const pidFile2 = join(herdr.dir, "dummy2.pid");
      await herdrRequest(herdr.socketPath, "pane.send_text", {
        pane_id: split.pane.pane_id,
        text: `sh -c 'echo $$ > ${pidFile2}; exec sleep 300'\n`,
      });
      await waitFor(() => existsSync(pidFile2) && readFileSync(pidFile2, "utf8").trim() !== "", 5000, "pid file 2");
      const pid2 = Number(readFileSync(pidFile2, "utf8").trim());
      await link.refresh(); // what the hub does when a new session registers
      await waitFor(() => link.match(pid2)?.paneId === split.pane.pane_id, 5000, "second pid matched");

      await link.focus(split.pane.pane_id); // isolated server only

      // resume() into the matching workspace: a new tab whose shell receives the text.
      const resumedFile = join(herdr.dir, "resumed.pid");
      const resumed = await link.resume({
        cwd: herdr.dir,
        repoRoot: herdr.dir,
        command: `echo $$ > ${resumedFile}`,
        label: "resumed tab",
      });
      expect(resumed.paneId.split(":")[0]).toBe(paneId.split(":")[0]);
      await waitFor(() => existsSync(resumedFile) && readFileSync(resumedFile, "utf8").trim() !== "", 5000, "resumed text ran");
      const shellPid = Number(readFileSync(resumedFile, "utf8").trim());
      const info = (await herdrRequest(herdr.socketPath, "pane.process_info", { pane_id: resumed.paneId })) as {
        process_info: { shell_pid: number };
      };
      expect(info.process_info.shell_pid).toBe(shellPid);
      await link.refresh();
      await waitFor(() => link.match(shellPid)?.tabLabel === "resumed tab", 5000, "resumed pane mapped with its tab label");

      // No workspace shows this repo: a new workspace named after it.
      const other = join(herdr.dir, "other-repo");
      mkdirSync(other);
      const otherFile = join(herdr.dir, "other.pid");
      const fresh = await link.resume({ cwd: other, repoRoot: other, command: `echo $$ > ${otherFile}`, label: "x" });
      expect(fresh.paneId.split(":")[0]).not.toBe(paneId.split(":")[0]);
      await waitFor(() => existsSync(otherFile) && readFileSync(otherFile, "utf8").trim() !== "", 5000, "text in new workspace");
      await link.refresh();
      const otherPid = Number(readFileSync(otherFile, "utf8").trim());
      await waitFor(() => link.match(otherPid)?.workspaceLabel === "other-repo", 5000, "new workspace label");
    } finally {
      link.close();
    }
  }, 30_000);
});
