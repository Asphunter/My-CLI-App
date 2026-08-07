import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationHasContent,
  isUntitledConversation,
  preferredThreadForProject,
  type SelectableConversation,
} from "../src/conversationSelection.ts";

const project = {
  path: "C:/projects/demo",
  threads: ["Régi munka", "Új beszélgetés"],
};

const cache: Record<string, SelectableConversation> = {
  "C:/projects/demo/Régi munka": {
    messages: [{ id: "m1" }],
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
  "C:/projects/demo/Új beszélgetés": { messages: [], workItems: [] },
};

test("an untitled empty conversation is skipped when only landing somewhere", () => {
  assert.equal(
    preferredThreadForProject(project, cache, "Új beszélgetés"),
    "Régi munka",
  );
  assert.equal(preferredThreadForProject(project, cache, ""), "Régi munka");
});

test("a live selection survives a refresh even while still empty", () => {
  assert.equal(
    preferredThreadForProject(project, cache, "Új beszélgetés", {
      keepLiveSelection: true,
    }),
    "Új beszélgetés",
  );
});

test("a live selection that no longer exists falls back to a populated thread", () => {
  assert.equal(
    preferredThreadForProject(project, cache, "Törölt szál", {
      keepLiveSelection: true,
    }),
    "Régi munka",
  );
});

test("a named conversation is kept even when empty and not marked live", () => {
  const named = {
    path: "C:/projects/demo",
    threads: ["Tervezés"],
  };
  assert.equal(preferredThreadForProject(named, {}, "Tervezés"), "Tervezés");
});

test("the newest populated thread wins when there is nothing to keep", () => {
  const many = {
    path: "C:/p",
    threads: ["a", "b", "c"],
  };
  const store: Record<string, SelectableConversation> = {
    "C:/p/a": { messages: [{}], updatedAt: "2026-01-01T00:00:00.000Z" },
    "C:/p/b": { messages: [{}], updatedAt: "2026-03-01T00:00:00.000Z" },
    "C:/p/c": { messages: [], updatedAt: "2026-09-01T00:00:00.000Z" },
  };
  assert.equal(preferredThreadForProject(many, store, ""), "b");
});

test("work items alone count as content", () => {
  assert.equal(conversationHasContent({ workItems: [{}] }), true);
  assert.equal(conversationHasContent({ messages: [], workItems: [] }), false);
  assert.equal(conversationHasContent(null), false);
});

test("numbered untitled conversations are recognised", () => {
  assert.equal(isUntitledConversation("Új beszélgetés"), true);
  assert.equal(isUntitledConversation("  Új beszélgetés 3 "), true);
  assert.equal(isUntitledConversation("Új beszélgetés terve"), false);
});
