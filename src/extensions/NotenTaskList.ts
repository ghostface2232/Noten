import TaskList from "@tiptap/extension-task-list";
import { tokenizeTaskList } from "./taskListTokenizer";

// Stock except for which lines under a task item are its content and how they
// are dedented; see taskListTokenizer.ts. Keeps the stock name, so
// boundedBlockTokenizers.ts still bounds it.
export const NotenTaskList = TaskList.extend({
  markdownTokenizer: {
    ...TaskList.config.markdownTokenizer!,
    tokenize: tokenizeTaskList as NonNullable<typeof TaskList.config.markdownTokenizer>["tokenize"],
  },
});

export default NotenTaskList;
