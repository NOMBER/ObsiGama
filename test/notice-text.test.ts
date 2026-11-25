import { describe, expect, it } from "vitest";
import { noticeText } from "../src/notice-text";

describe("noticeText", () => {
  it("describes friend and badge events, never achievements", () => {
    expect(noticeText({ kind: "friend_request", actor_username: "Ada", badge_name: null }))
      .toBe("@Ada sent you a friend request");
    expect(noticeText({ kind: "friend_accepted", actor_username: "Ada", badge_name: null }))
      .toBe("@Ada accepted your friend request");
    expect(noticeText({ kind: "badge", actor_username: null, badge_name: "Welcome" }))
      .toBe("New badge: Welcome");
    expect(noticeText({ kind: "friend_accepted", actor_username: null, badge_name: null }))
      .toBe("Someone accepted your friend request");
  });
});
