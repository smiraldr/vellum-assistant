import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

import { useSideMenuCollapsed } from "@vellumai/design-library";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { LS_ASSISTANT_INBOX_HIDDEN } from "@/utils/local-settings-keys";
import { routes } from "@/utils/routes";

import { useAssistantInboxState } from "../hooks/use-assistant-inbox-state";
import { AssistantInboxNavItem } from "./assistant-inbox-nav-item";

export interface AssistantInboxRailEntryProps {
  /** `null` before an assistant is active, when there is nothing to open. */
  assistantId: string | null;
}

/**
 * The Assistant Inbox's place on the rail, above Preferences. Renders
 * nothing unless the `assistant-inbox` flag is on and an assistant is
 * active; only then does the entry below mount and ask the platform what
 * state the inbox is in, so a chat layout with the flag off makes no inbox
 * reads at all.
 */
export function AssistantInboxRailEntry({
  assistantId,
}: AssistantInboxRailEntryProps) {
  const enabled = useClientFeatureFlagStore.use.assistantInbox();
  if (!enabled || !assistantId) {
    return null;
  }
  return <EnabledRailEntry assistantId={assistantId} />;
}

/**
 * The entry once the flag allows it. Hidden while the inbox is unavailable
 * or still resolving. In the upgrade-required state the entry is a pitch,
 * so it carries a dismiss; the dismissal is remembered on this device and
 * stops applying the moment the org is entitled, since then there is an
 * inbox to open.
 */
function EnabledRailEntry({ assistantId }: { assistantId: string }) {
  const collapsed = useSideMenuCollapsed();
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(
    () => getLocalSetting(LS_ASSISTANT_INBOX_HIDDEN, "0") === "1",
  );

  const { status } = useAssistantInboxState(assistantId, "");

  const open = useCallback(() => {
    navigate(routes.assistantInbox);
  }, [navigate]);

  const dismiss = useCallback(() => {
    setLocalSetting(LS_ASSISTANT_INBOX_HIDDEN, "1");
    setHidden(true);
  }, []);

  if (status === "unavailable" || status === "loading") {
    return null;
  }
  const upgradeOnly = status === "upgrade";
  if (upgradeOnly && hidden) {
    return null;
  }

  return (
    <AssistantInboxNavItem
      assistantId={assistantId}
      collapsed={collapsed}
      onSelect={open}
      onDismiss={upgradeOnly ? dismiss : undefined}
    />
  );
}
