/**
 * Open a CES RPC client over the shared bootstrap socket.
 *
 * Assistant boot (`startCes`) and child-process credential resolution
 * (`tryLazyCesConnect`) use this helper. Both are CES API clients: they
 * discover `ces.sock`, connect, handshake, and reconnect with the same
 * process manager. Handshake identity (assistant API key) is optional so
 * the assistant can forward it at boot while children connect without it.
 */

import type { AssistantConfig } from "../config/schema.js";
import { getLogger } from "../util/logger.js";
import {
  type CesClient,
  type CesClientHandshakeOptions,
  createCesClient,
} from "./client.js";
import {
  type CesProcessManager,
  CesUnavailableError,
  createCesProcessManager,
  type CesProcessManagerConfig,
} from "./process-manager.js";

const log = getLogger("ces-connect");

export interface CesRpcSession {
  client: CesClient;
  processManager: CesProcessManager;
}

export interface OpenCesRpcSessionOptions {
  /**
   * Reuse an existing process manager (reconnect after `stop()`). When
   * omitted, a new manager is created.
   */
  processManager?: CesProcessManager;
  handshake?: CesClientHandshakeOptions;
  signal?: AbortSignal;
  assistantConfig?: AssistantConfig;
  discover?: CesProcessManagerConfig["discover"];
}

/**
 * Discover the CES socket, connect, and complete the RPC handshake.
 *
 * Returns undefined when CES is missing, the handshake is rejected, the
 * abort signal fires, or the transport fails. The process manager is
 * stopped on those paths so a later reconnect can call `start()` again.
 */
export async function openCesRpcSession(
  options: OpenCesRpcSessionOptions = {},
): Promise<CesRpcSession | undefined> {
  const pm =
    options.processManager ??
    createCesProcessManager({
      assistantConfig: options.assistantConfig,
      discover: options.discover,
    });

  const fail = async (): Promise<undefined> => {
    await pm.stop().catch(() => {});
    return undefined;
  };

  if (options.signal?.aborted) {
    return fail();
  }

  try {
    const transport = await pm.start();
    if (options.signal?.aborted) {
      return fail();
    }

    const client = createCesClient(transport);
    const { accepted, reason } = await client.handshake(options.handshake);
    if (options.signal?.aborted) {
      client.close();
      return fail();
    }
    if (!accepted) {
      log.warn({ reason }, "CES handshake rejected");
      client.close();
      return fail();
    }

    return { client, processManager: pm };
  } catch (err) {
    if (err instanceof CesUnavailableError) {
      log.info({ reason: err.message }, "CES is not available");
    } else {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "Failed to open CES RPC session",
      );
    }
    return fail();
  }
}
