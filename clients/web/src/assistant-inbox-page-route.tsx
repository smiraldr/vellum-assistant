import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Navigate, useNavigate } from "react-router";

import { useMutation } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { AssistantInboxPage } from "@/domains/assistant-inbox/components/assistant-inbox-page";
import { AssistantInboxSetupCard } from "@/domains/assistant-inbox/components/assistant-inbox-setup-card";
import { AssistantInboxShell } from "@/domains/assistant-inbox/components/assistant-inbox-shell";
import { AssistantInboxUpgradeState } from "@/domains/assistant-inbox/components/assistant-inbox-upgrade-state";
import { useAssistantInboxState } from "@/domains/assistant-inbox/hooks/use-assistant-inbox-state";
import { useInboxMail } from "@/domains/assistant-inbox/hooks/use-inbox-mail";
import type { InboxEmail } from "@/domains/assistant-inbox/types";
import {
  assistantsDomainsCreateMutation,
  assistantsEmailAddressesCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { extractErrorMessage } from "@/utils/api-errors";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

function InboxLoading({ label }: { label: string }) {
  return (
    <AssistantInboxShell>
      <div
        role="status"
        className="flex flex-1 items-center justify-center gap-2 text-body-small-lighter text-[var(--content-tertiary)]"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {label}
      </div>
    </AssistantInboxShell>
  );
}

interface MailboxProps {
  assistantId: string;
  platformAssistantId: string;
  assistantName: string;
  address: string;
  addressId: string;
}

/** The mailbox with its reads attached; split out so its hooks run only in the ready state. */
function Mailbox({
  assistantId,
  platformAssistantId,
  assistantName,
  address,
  addressId,
}: MailboxProps) {
  const { t } = useTranslation("assistant-inbox");
  const navigate = useNavigate();
  const mail = useInboxMail(assistantId, platformAssistantId, addressId);

  const askToReply = useCallback(
    (email: InboxEmail) => {
      navigateToNewConversation(navigate, {
        prompt: t("assistantInboxRoute.replyPrompt", {
          id: email.id,
          sender: email.from.name?.trim() || email.from.address,
          subject: email.subject || t("emailListRow.noSubject"),
        }),
      });
    },
    [navigate, t],
  );

  if (mail.isLoading) {
    return <InboxLoading label={t("assistantInboxRoute.loading")} />;
  }

  return (
    <AssistantInboxPage
      assistantId={assistantId}
      assistantName={assistantName}
      address={address}
      inbox={mail.received}
      sent={mail.sent}
      usage={mail.usage}
      loadDetail={mail.loadDetail}
      onAskToReply={askToReply}
    />
  );
}

/**
 * `/assistant/inbox`. Picks the inbox's state for the active assistant and
 * draws it: the upgrade card, the setup card, or the mailbox. Behind the
 * `assistant-inbox` flag; with it off the route sends the user to chat, so
 * a stale link never opens a surface the rail does not offer.
 */
export function AssistantInboxPageRoute() {
  const { t } = useTranslation("assistant-inbox");
  const enabled = useClientFeatureFlagStore.use.assistantInbox();
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();
  const identityName = useAssistantIdentityStore.use.name();
  const state = useAssistantInboxState(assistantId, identityName ?? "");
  const [settling, setSettling] = useState(false);

  const createDomain = useMutation(assistantsDomainsCreateMutation());
  const createAddress = useMutation(assistantsEmailAddressesCreateMutation());

  const confirmSetup = useCallback(
    async ({ prefix }: { prefix: string }) => {
      if (!state.platformAssistantId) {
        return;
      }
      const path = { assistant_id: state.platformAssistantId };
      setSettling(true);
      try {
        if (state.hasDomain) {
          await createAddress.mutateAsync({
            path,
            body: { username: prefix },
          });
        } else {
          // One call registers the subdomain and the address on it; the
          // platform derives the subdomain from the handle when omitted.
          await createDomain.mutateAsync({
            path,
            body: {
              ...(state.handle ? { subdomain: state.handle } : {}),
              email_username: prefix,
            },
          });
        }
        await state.refreshAddresses();
        toast.success(
          t("assistantInboxRoute.setupSucceeded", {
            address: `${prefix}@${state.handle}.${state.rootDomain}`,
          }),
        );
      } catch (err) {
        captureError(err, { context: "assistant_inbox_setup" });
        toast.error(
          extractErrorMessage(
            err,
            undefined,
            t("assistantInboxRoute.setupFailed"),
          ),
        );
      } finally {
        setSettling(false);
      }
    },
    [createAddress, createDomain, state, t],
  );

  if (!enabled) {
    return <Navigate to="/" replace />;
  }

  switch (state.status) {
    case "unavailable":
      return <Navigate to="/" replace />;
    case "loading":
      return <InboxLoading label={t("assistantInboxRoute.loading")} />;
    case "upgrade":
      return (
        <AssistantInboxUpgradeState
          assistantId={assistantId}
          assistantName={state.assistantName}
          handle={state.handle}
          rootDomain={state.rootDomain}
          onUpgrade={() => navigate(routes.plans)}
          onSeePlans={() => navigate(routes.plans)}
        />
      );
    case "setup":
      return (
        <AssistantInboxSetupCard
          assistantId={assistantId}
          handle={state.handle}
          rootDomain={state.rootDomain}
          onConfirm={(draft) => void confirmSetup(draft)}
          busy={settling}
        />
      );
    case "ready":
      return (
        <Mailbox
          assistantId={assistantId}
          platformAssistantId={state.platformAssistantId ?? ""}
          assistantName={state.assistantName}
          address={state.address ?? ""}
          addressId={state.addressId ?? ""}
        />
      );
  }
}
