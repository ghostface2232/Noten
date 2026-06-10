import { describe, it, expect } from "vitest";
import { getSlashItems, filterSlashItems } from "./SlashCommands";

// Items are matched by their stable icon name (titles are localized).
const byIcon = (icon: string) => (item: { icon: string }) => item.icon === icon;

describe("filterSlashItems", () => {
  const items = getSlashItems("en");

  it("returns every item for an empty or whitespace query", () => {
    expect(filterSlashItems(items, "")).toHaveLength(items.length);
    expect(filterSlashItems(items, "   ")).toHaveLength(items.length);
  });

  it("matches English aliases that are not the canonical title", () => {
    expect(filterSlashItems(items, "todo").some(byIcon("TaskListLtr"))).toBe(true);
    expect(filterSlashItems(items, "ul").some(byIcon("TextBulletList"))).toBe(true);
    expect(filterSlashItems(items, "snippet").some(byIcon("CodeBlock"))).toBe(true);
    expect(filterSlashItems(items, "divider").some(byIcon("LineHorizontal1"))).toBe(true);
  });

  it("matches Korean aliases regardless of UI locale", () => {
    expect(filterSlashItems(items, "할일").some(byIcon("TaskListLtr"))).toBe(true);
    expect(filterSlashItems(items, "표").some(byIcon("Table"))).toBe(true);
    expect(filterSlashItems(getSlashItems("ko"), "그림").some(byIcon("ImageAdd"))).toBe(true);
  });

  it("is case-insensitive on both query and alias", () => {
    expect(filterSlashItems(items, "TODO").some(byIcon("TaskListLtr"))).toBe(true);
    expect(filterSlashItems(items, "ToDo").some(byIcon("TaskListLtr"))).toBe(true);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterSlashItems(items, "zzzznotacommand")).toHaveLength(0);
  });

  it("every item exposes at least one alias so it stays searchable", () => {
    for (const item of items) {
      expect(item.searchTerms.length).toBeGreaterThan(0);
    }
  });
});
