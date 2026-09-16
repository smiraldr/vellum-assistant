import type { DisplayMessage } from "@/domains/chat/types/types";
import type { MessageItem } from "@/domains/chat/transcript/types";

function addMessage(
  messages: DisplayMessage[],
  seenIds: Set<string>,
  message: DisplayMessage,
): void {
  if (!seenIds.has(message.id)) {
    seenIds.add(message.id);
    messages.push(message);
  }
}

/** Canonical rows represented by one rendered transcript message item. */
export function messageItemMembers(
  item: MessageItem,
): readonly DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const seenIds = new Set<string>();
  for (const frame of item.cameraFrames ?? []) {
    addMessage(messages, seenIds, frame);
  }
  addMessage(messages, seenIds, item.message);
  return messages;
}

/** Canonical ids and merged aliases represented by one transcript item. */
export function messageItemIdentityIds(item: MessageItem): readonly string[] {
  const ids = new Set<string>();
  for (const message of messageItemMembers(item)) {
    ids.add(message.id);
    for (const alias of message.mergedMessageIds ?? []) {
      if (alias.length > 0) {
        ids.add(alias);
      }
    }
  }
  return [...ids];
}

export function messageItemHasIdentity(
  item: MessageItem,
  messageId: string | null,
): boolean {
  return messageId !== null && messageItemIdentityIds(item).includes(messageId);
}
