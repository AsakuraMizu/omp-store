import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Entry, findRoot, idsIn, localDay, Store, STORE_DIR } from "./db";
import rules from "./rules.md" with { type: "text" };

const READ_TOOLS = ["store_search"];
const WRITE_TOOLS = ["store_put", "store_update", "store_drop", "store_restore"];
const SEARCH_LIMIT = 20;
const SIMILAR_LIMIT = 5;

const stores = new Map<string, Store>();
let mainSessionId: string | undefined;

function openStore(root: string, create = false): Store {
  let store = stores.get(root);
  if (!store) {
    store = new Store(root, create);
    stores.set(root, store);
  }
  return store;
}

function editTargets(input: Record<string, unknown>): string[] {
  const targets: string[] = [];
  if (typeof input.path === "string") targets.push(input.path);
  if (Array.isArray(input.paths)) targets.push(...input.paths.filter(p => typeof p === "string"));
  if (typeof input.input === "string") {
    for (const m of input.input.matchAll(/^\[(.+?)#[0-9A-Za-z]{4}\]\s*$/gm)) targets.push(m[1]);
  }
  return targets;
}

export default function ompStore(pi: ExtensionAPI) {
  pi.setLabel("omp-store");
  const z = pi.zod;
  let store: Store | undefined;
  let rulesText = "";
  const pendingUse = new Map<string, number>();
  const straysToldAgent = new Set<string>();
  const straysToldUser = new Set<string>();

  const displayPath = (ctx: ExtensionContext, id?: string) => {
    const target = id ? store!.entryDir(id) : store!.dir;
    const rel = relative(ctx.cwd, target);
    return `${rel.startsWith("..") ? target : rel}/`;
  };

  /** The entry id a path falls in, `null` for the store directory itself, `undefined` outside the store. */
  const entryOf = (ctx: ExtensionContext, path: string): string | null | undefined => {
    const rel = relative(store!.dir, resolve(ctx.cwd, path));
    if (rel === "") return null;
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return rel.split(sep)[0];
  };

  const format = (ctx: ExtensionContext, e: Entry) => {
    const lines = [`${e.id}  ${displayPath(ctx, e.id)}  last used ${localDay(e.lastUsed)}  created ${localDay(e.created)} in session ${e.session}`];
    lines.push(`  ${e.title}`);
    if (e.description) lines.push(...e.description.split("\n").map(l => `  ${l}`));
    if (e.trashedAt !== null) lines.push(`  in trash since ${localDay(e.trashedAt)}: ${e.dropReason}`);
    const dependencies = store!.dependencies(e.id);
    if (dependencies.length > 0) lines.push(`  depends on ${dependencies.join(", ")}`);
    const dependents = store!.dependents(e.id);
    if (dependents.length > 0) lines.push(`  used by ${dependents.join(", ")}`);
    return lines.join("\n");
  };

  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

  const flush = () => {
    if (!store || pendingUse.size === 0) return;
    store.touch(pendingUse);
    pendingUse.clear();
  };

  const runCleanup = async (ctx: ExtensionContext) => {
    const plan = store!.cleanupPlan();
    if (plan.expire.length === 0 && plan.purge.length === 0) return;
    await store!.applyCleanup(plan);
    ctx.ui.notify(`omp-store: ${plan.expire.length} moved to trash, ${plan.purge.length} purged`, "info");
  };

  const activate = async (ctx: ExtensionContext, root: string, create = false) => {
    store = openStore(root, create);
    rulesText = rules.replaceAll("{{path}}", displayPath(ctx));
    const active = pi.getActiveTools();
    const tools = active.includes("write") ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
    await pi.setActiveTools([...new Set([...active, ...tools])]);
  };

  const requireEntry = (id: string): Entry => {
    const entry = store!.get(id);
    if (!entry) throw new Error(`No store entry with id ${id}`);
    return entry;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind === "main") mainSessionId = ctx.sessionManager.getSessionId();
    const root = findRoot(ctx.cwd);
    if (root) await activate(ctx, root);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!store) return;
    if (ctx.agent.kind === "main" && event.reason === "prompt") {
      const today = localDay(Date.now());
      store.recordActiveDay(today);
      if (store.claimCleanup(today)) {
        flush();
        void runCleanup(ctx).catch(err => ctx.ui.notify(`omp-store: cleanup failed: ${err}`, "error"));
      }
    }
    return { systemPrompt: [...event.systemPrompt, rulesText] };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!store) return;
    if (event.toolName === "write" || event.toolName === "edit") {
      for (const target of editTargets(event.input)) {
        const owner = entryOf(ctx, target);
        if (owner === undefined || (owner !== null && store.get(owner))) continue;
        return {
          block: true,
          reason: `${target} is not inside a store entry. Create one with store_put and write inside the directory it returns.`,
        };
      }
    }
    const now = Date.now();
    const used = idsIn(JSON.stringify(event.input))
      .filter(id => store!.get(id))
      .flatMap(id => store!.withDependencies(id));
    for (const id of new Set(used)) {
      const entry = store.get(id)!;
      pendingUse.set(id, now);
      if (entry.trashedAt !== null) {
        store.restore(id);
        ctx.ui.notify(`omp-store: restored ${id} (${entry.title}) from trash because it was used`, "info");
      }
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (!store || event.isError) return;
    const notes: string[] = [];
    if (event.toolName === "write" || event.toolName === "edit") {
      const refs = idsIn(JSON.stringify(event.input)).filter(id => store!.get(id));
      for (const target of editTargets(event.input)) {
        const owner = entryOf(ctx, target);
        const others = refs.filter(id => id !== owner);
        if (others.length === 0) continue;
        if (owner) {
          for (const id of others) store.addDependency(owner, id);
        } else {
          notes.push(
            `${target} now refers to store ${others.length === 1 ? "entry" : "entries"} ${others.join(", ")}. Use from outside the store is not tracked, so the entry can expire under this file. Move the script into the entry, or tell the user about this dependency.`,
          );
        }
      }
    }
    if (event.toolName === "bash" && typeof event.input.command === "string" && event.input.command.includes(STORE_DIR)) {
      const strays = store.strays().filter(name => !straysToldAgent.has(name));
      for (const name of strays) straysToldAgent.add(name);
      if (strays.length > 0) {
        notes.push(
          `${displayPath(ctx)} now has ${strays.join(", ")}, which no store entry owns. Create an entry with store_put and move it inside.`,
        );
      }
    }
    if (notes.length > 0) return { additionalContext: notes.join("\n") };
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!store) return;
    flush();
    const strays = store.strays().filter(name => !straysToldUser.has(name));
    for (const name of strays) straysToldUser.add(name);
    if (strays.length > 0) ctx.ui.notify(`omp-store: unregistered items in ${displayPath(ctx)}: ${strays.join(", ")}`, "warning");
  });

  pi.on("session_shutdown", () => flush());

  pi.registerTool({
    name: "store_put",
    label: "Store put",
    description:
      "Create a workspace store entry and return its directory. Write everything for the entry inside that directory with the usual tools. The result lists existing entries with similar titles; when one of them is the same thing, drop the entry just created and use that one instead.",
    parameters: z.object({
      title: z.string().describe("One line saying what the entry is"),
      description: z
        .string()
        .optional()
        .describe("How to use it, how to regenerate it, what it was made for"),
    }),
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session =
        ctx.agent.kind === "main" ? ctx.sessionManager.getSessionId() : (mainSessionId ?? ctx.sessionManager.getSessionId());
      const entry = store!.put(params.title, params.description ?? "", session);
      const similar = store!.search(params.title, false, SIMILAR_LIMIT + 1).filter(e => e.id !== entry.id).slice(0, SIMILAR_LIMIT);
      const parts = [`Created ${entry.id}; write inside ${displayPath(ctx, entry.id)}`];
      if (similar.length > 0) parts.push("Similar entries:", ...similar.map(e => format(ctx, e)));
      return text(parts.join("\n"));
    },
  });

  pi.registerTool({
    name: "store_search",
    label: "Store search",
    description:
      "Search the workspace store by keywords in entry titles and descriptions. Without a query, list the most recently used entries. Trashed entries are left out unless include_trash is set.",
    parameters: z.object({
      query: z.string().optional().describe("Keywords"),
      include_trash: z.boolean().optional(),
    }),
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const found = store!.search(params.query ?? "", params.include_trash ?? false, SEARCH_LIMIT);
      return text(found.length > 0 ? found.map(e => format(ctx, e)).join("\n") : "No matching entries.");
    },
  });

  pi.registerTool({
    name: "store_update",
    label: "Store update",
    description: "Change the title or description of a workspace store entry.",
    parameters: z.object({
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
    }),
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireEntry(params.id);
      store!.update(params.id, { title: params.title, description: params.description });
      return text(format(ctx, store!.get(params.id)!));
    },
  });

  pi.registerTool({
    name: "store_drop",
    label: "Store drop",
    description:
      "Move a workspace store entry to the trash: it disappears from search, and its files are deleted after a few active days unless it is restored or used again.",
    parameters: z.object({
      id: z.string(),
      reason: z.string().describe("Why the entry is no longer wanted"),
    }),
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
    async execute(_id, params) {
      const entry = requireEntry(params.id);
      store!.drop(params.id, params.reason);
      return text(`Moved ${entry.id} (${entry.title}) to the trash. Tell the user in your reply which entry you dropped and why.`);
    },
  });

  pi.registerTool({
    name: "store_restore",
    label: "Store restore",
    description: "Bring a trashed workspace store entry back.",
    parameters: z.object({ id: z.string() }),
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireEntry(params.id);
      store!.restore(params.id);
      return text(format(ctx, store!.get(params.id)!));
    },
  });

  pi.registerCommand("store", {
    description: "Workspace store: init, list, search <words>, trash, restore <id>, drop <id>, clean",
    handler: async (args, ctx) => {
      const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === "init") {
        const existing = findRoot(ctx.cwd);
        if (existing) {
          ctx.ui.notify(`A store already exists at ${existing}/${STORE_DIR}`, "warning");
          return;
        }
        await activate(ctx, ctx.cwd, true);
        ctx.ui.notify(`Created ${displayPath(ctx)}; store tools are active from the next message`, "info");
        return;
      }
      if (!store) {
        ctx.ui.notify("No store in this workspace. Run /store init at the workspace root.", "warning");
        return;
      }
      const listing = (entries: Entry[]) =>
        entries.length > 0
          ? entries
              .map(e => `${e.id}  ${localDay(e.trashedAt ?? e.lastUsed)}  ${e.title}${e.dropReason ? `  (${e.dropReason})` : ""}`)
              .join("\n")
          : "Nothing to show.";
      switch (sub) {
        case "list":
          ctx.ui.notify(listing(store.all(false)), "info");
          return;
        case "search":
          ctx.ui.notify(listing(store.search(rest.join(" "), true, SEARCH_LIMIT)), "info");
          return;
        case "trash":
          ctx.ui.notify(listing(store.all(true)), "info");
          return;
        case "restore":
        case "drop": {
          const entry = rest[0] ? store.get(rest[0]) : undefined;
          if (!entry) {
            ctx.ui.notify(`No store entry with id ${rest[0] ?? "(none given)"}`, "warning");
            return;
          }
          if (sub === "restore") store.restore(entry.id);
          else store.drop(entry.id, "dropped by the user");
          ctx.ui.notify(`${sub === "restore" ? "Restored" : "Moved to trash"}: ${entry.id} ${entry.title}`, "info");
          return;
        }
        case "clean": {
          flush();
          const plan = store.cleanupPlan();
          if (plan.expire.length === 0 && plan.purge.length === 0) {
            ctx.ui.notify("Nothing to clean.", "info");
            return;
          }
          const summary = [
            ...plan.expire.map(e => `to trash: ${e.id} ${e.title}`),
            ...plan.purge.map(e => `delete: ${e.id} ${e.title}`),
          ].join("\n");
          if (await ctx.ui.confirm("Clean the store?", summary)) await runCleanup(ctx);
          return;
        }
        default:
          ctx.ui.notify(`Unknown subcommand ${sub}. Use init, list, search, trash, restore, drop or clean.`, "warning");
      }
    },
  });
}
