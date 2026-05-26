import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  TextTRegular,
  TextHeader1Regular,
  TextHeader2Regular,
  TextHeader3Regular,
  TextBulletListRegular,
  TextNumberListLtrRegular,
  TaskListLtrRegular,
  TextQuoteOpeningRegular,
  CodeBlockRegular,
  FlowchartRegular,
  LineHorizontal1Regular,
  ImageAddRegular,
  TableRegular,
} from "@fluentui/react-icons";
import type { Editor, Range } from "@tiptap/core";
import "../styles/slash-command.css";

export interface SlashCommandItem {
  title: string;
  description: string;
  searchTerms: string[];
  icon: string;
  command: (props: { editor: Editor; range: Range }) => void;
}

export interface SlashCommandListRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface SlashCommandListProps {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
}

const ICON_MAP: Record<string, React.ReactElement> = {
  TextT: <TextTRegular />,
  TextHeader1: <TextHeader1Regular />,
  TextHeader2: <TextHeader2Regular />,
  TextHeader3: <TextHeader3Regular />,
  TextBulletList: <TextBulletListRegular />,
  TextNumberListLtr: <TextNumberListLtrRegular />,
  TaskListLtr: <TaskListLtrRegular />,
  TextQuoteOpening: <TextQuoteOpeningRegular />,
  CodeBlock: <CodeBlockRegular />,
  Flowchart: <FlowchartRegular />,
  LineHorizontal1: <LineHorizontal1Regular />,
  ImageAdd: <ImageAddRegular />,
  Table: <TableRegular />,
};

export const SlashCommandList = forwardRef<
  SlashCommandListRef,
  SlashCommandListProps
>(function SlashCommandList({ items, command }, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  // Scroll only the menu so the editor viewport stays put.
  useLayoutEffect(() => {
    const container = listRef.current;
    const el = container?.children[selectedIndex] as HTMLElement | undefined;
    if (!container || !el) return;

    const cTop = container.scrollTop;
    const cBottom = cTop + container.clientHeight;
    const eTop = el.offsetTop;
    const eBottom = eTop + el.offsetHeight;

    if (eTop < cTop) {
      container.scrollTop = eTop;
    } else if (eBottom > cBottom) {
      container.scrollTop = eBottom - container.clientHeight;
    }
  }, [selectedIndex]);

  const selectItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) command(item);
    },
    [items, command],
  );

  useImperativeHandle(ref, () => ({
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        selectItem(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) return null;

  return (
    <div className="slash-command-menu" ref={listRef}>
      {items.map((item, index) => (
        <button
          key={item.title}
          className={`slash-command-item${index === selectedIndex ? " is-selected" : ""}`}
          onClick={() => selectItem(index)}
          onMouseEnter={() => setSelectedIndex(index)}
          type="button"
        >
          <span className="slash-command-icon">
            {ICON_MAP[item.icon] ?? null}
          </span>
          <span className="slash-command-text">
            <span className="slash-command-title">{item.title}</span>
            <span className="slash-command-desc">{item.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
});
