import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, expect } from "vitest";

import { writeElectronBoundaryFixture } from "../../fixtures/electronBoundaryApplication.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

/** Source-owned Electron conformance fixture; its code is never executed. */
const FIXTURE = resolve("tests/conformance/readiness/electron");
const SURFACES = ["CLI", "stdio MCP"] as const;
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

cliTest.for(SURFACES)(
  "inventories contextBridge APIs, IPC channels, and paired handlers from inert syntax through %s",
  async (surface, { cli }) => {
    const analysis = await analyzeJavaScriptDirectory(surface, cli, FIXTURE);
    const { nodes, edges } = analysis.graph;

    expect(analysis.summary).toMatchObject({
      context_bridge_apis: 1,
      exposed_api_members: 2,
      ipc: {
        literal_channels: 2,
        main_handlers: 1,
        paired_renderer_transmissions: 1,
        unpaired_literal_renderer_transmissions: 0,
      },
    });

    const bridges = nodes.filter((node) => node.kind === "context-bridge-api");
    expect(bridges).toHaveLength(1);
    const bridge = bridges[0]?.observations[0];
    expect(bridge?.properties).toMatchObject({
      api_key: "readiness",
      api_status: "object-literal",
      unknown_members: 0,
    });
    expect(bridge?.properties.members).toEqual(
      expect.arrayContaining(["echo", "onDeepLink"]),
    );
    expect(bridge?.evidence).toMatchObject({
      authority: "ast-static-analysis",
      state: "observed",
      confidence: "exact",
      location: {
        available: true,
        value: { kind: "source-range", source: "preload.js" },
      },
    });

    const channels = nodes.filter((node) => node.kind === "ipc-channel");
    expect(
      channels.map((node) => node.observations[0]?.properties.channel),
    ).toEqual(expect.arrayContaining(["readiness:echo", "deep-link"]));

    const invoked = channels.find(
      (node) =>
        node.observations[0]?.properties.channel === "readiness:echo" &&
        node.observations[0]?.properties.operation === "invoke",
    );
    expect(invoked?.observations[0]?.properties.resolution).toBe("literal");
    expect(invoked?.observations[0]?.evidence).toMatchObject({
      authority: "ast-static-analysis",
      state: "observed",
      confidence: "exact",
      location: {
        available: true,
        value: { kind: "source-range", source: "preload.js" },
      },
    });

    // One listener channel carries both the observed use and the inferred
    // counterpart that completes the relationship; authority stays per node.
    const listeners = channels.filter(
      (node) => node.observations[0]?.properties.channel === "deep-link",
    );
    expect(listeners.length).toBeGreaterThan(0);
    for (const listener of listeners)
      expect(listener.observations[0]?.properties).toMatchObject({
        operation: "on",
        resolution: "literal",
      });
    const listenerStates = listeners.map(
      (node) => node.observations[0]?.evidence.state,
    );
    expect(listenerStates).toContain("observed");
    expect(listenerStates).toContain("inferred");

    const handler = nodes
      .filter((node) => node.kind === "ipc-handler")
      .find(
        (node) =>
          node.observations[0]?.properties.channel === "readiness:echo" &&
          node.observations[0]?.properties.operation === "handle",
      );
    expect(handler?.observations[0]?.evidence).toMatchObject({
      state: "observed",
      confidence: "exact",
      location: {
        available: true,
        value: { kind: "source-range", source: "main.js" },
      },
    });

    const paired = edges.filter(
      (edge) =>
        edge.relation === "invokes" &&
        edge.properties.pairing_basis === "unique-exact-literal-channel",
    );
    expect(paired).toHaveLength(1);
    expect(paired[0]?.properties.channel).toBe("readiness:echo");
    expect(paired[0]?.evidence).toMatchObject({
      authority: "static-relationship-inference",
      state: "inferred",
      confidence: "high",
    });

    // A renderer listener channel stays unpaired: no pairing edge may be invented.
    expect(
      edges.filter(
        (edge) =>
          edge.properties.channel === "deep-link" &&
          edge.properties.pairing_basis !== undefined,
      ),
    ).toHaveLength(0);
  },
);

cliTest.for(SURFACES)(
  "keeps dynamic channels, unpaired literals, and unresolved bridge members explicit through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-electron-ipc-boundary-");
    temporary.push(root);
    await writeElectronBoundaryFixture(root);

    const analysis = await analyzeJavaScriptDirectory(surface, cli, root);
    const { nodes, edges } = analysis.graph;

    expect(analysis.summary).toMatchObject({
      context_bridge_apis: 2,
      exposed_api_members: 5,
      ipc: {
        dynamic_channel_operations: 2,
        main_handlers: 5,
        paired_renderer_transmissions: 4,
        ambiguous_renderer_transmissions: 1,
        unpaired_literal_renderer_transmissions: 1,
      },
    });

    // A computed channel keeps its expression instead of an invented name.
    const dynamicChannels = nodes.filter(
      (node) =>
        node.kind === "ipc-channel" &&
        node.observations[0]?.properties.channel === null,
    );
    expect(dynamicChannels.length).toBeGreaterThan(0);
    for (const node of dynamicChannels) {
      expect(node.observations[0]?.properties).toMatchObject({
        resolution: "dynamic",
        channel_expression: "dynamicChannel",
      });
      expect(node.observations[0]?.evidence).toMatchObject({
        state: "observed",
        confidence: "exact",
      });
    }

    // Neither a computed channel nor an ambiguous literal may be paired.
    for (const channel of [null, "rea:ambiguous"] as const)
      expect(
        edges.filter(
          (edge) =>
            edge.properties.channel === channel &&
            edge.properties.pairing_basis !== undefined,
        ),
      ).toHaveLength(0);

    // A literal channel without a matching handler stays unpaired, not absent.
    const unpaired = nodes.find(
      (node) =>
        node.kind === "ipc-channel" &&
        node.observations[0]?.properties.channel === "rea:missing",
    );
    expect(unpaired?.observations[0]?.properties).toMatchObject({
      resolution: "literal",
      operation: "invoke",
    });
    expect(
      edges.filter(
        (edge) =>
          edge.properties.channel === "rea:missing" &&
          edge.properties.pairing_basis !== undefined,
      ),
    ).toHaveLength(0);

    // A computed bridge key keeps its expression and unresolved member count.
    const dynamicBridge = nodes.find(
      (node) =>
        node.kind === "context-bridge-api" &&
        node.observations[0]?.properties.api_key === null,
    );
    expect(dynamicBridge?.observations[0]?.properties).toMatchObject({
      api_key_expression: "dynamicApiKey",
      api_status: "dynamic",
      unknown_members: 1,
    });
  },
);
