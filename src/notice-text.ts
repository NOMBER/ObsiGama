export interface NoticeTextInput {
  kind: string;
  actor_username: string | null;
  badge_name: string | null;
}

export function noticeText(n: NoticeTextInput): string {
  const who = n.actor_username ? "@" + n.actor_username : "Someone";
  switch (n.kind) {
    case "friend_request": return `${who} sent you a friend request`;
    case "friend_accepted": return `${who} accepted your friend request`;
    case "badge": return `New badge: ${n.badge_name ?? "Badge"}`;
    default: return n.kind;
  }
}
