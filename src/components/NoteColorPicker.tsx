import { mergeClasses } from "@fluentui/react-components";
import { NOTE_COLORS, type NoteColorId } from "../utils/noteColors";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";
import { useStyles } from "./Sidebar.styles";

/** i18n key for each color's display label (swatch tooltip / aria-label). */
const COLOR_LABEL_KEY: Record<NoteColorId, Parameters<typeof t>[0]> = {
  red: "sidebar.colorRed",
  orange: "sidebar.colorOrange",
  yellow: "sidebar.colorYellow",
  green: "sidebar.colorGreen",
  blue: "sidebar.colorBlue",
  purple: "sidebar.colorPurple",
  pink: "sidebar.colorPink",
};

interface ColorSwatchRowProps {
  /** Currently selected color, or `null` for "no color". */
  value: NoteColorId | null;
  onSelect: (color: NoteColorId | null) => void;
  /** Render the trailing "no color" control. Default true. */
  includeNone?: boolean;
  locale: Locale;
}

/**
 * Horizontal row of color swatches — shared by the note context menu, the
 * select-mode bulk menu, and the sidebar color-filter popover.
 */
export function ColorSwatchRow({ value, onSelect, includeNone = true, locale }: ColorSwatchRowProps) {
  const styles = useStyles();

  return (
    <div className={styles.colorRow} role="group" aria-label={t("sidebar.color", locale)}>
      {NOTE_COLORS.map((c) => {
        const label = t(COLOR_LABEL_KEY[c.id], locale);
        return (
          <button
            key={c.id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={value === c.id}
            className={mergeClasses(styles.colorSwatch, value === c.id && styles.colorSwatchSelected)}
            style={{ backgroundColor: c.hex }}
            onClick={() => onSelect(c.id)}
          />
        );
      })}
      {includeNone && (
        // "No color" — an empty swatch (no icon), distinguished from the
        // colored swatches purely by having no fill.
        <button
          type="button"
          title={t("sidebar.colorNone", locale)}
          aria-label={t("sidebar.colorNone", locale)}
          aria-pressed={value === null}
          className={mergeClasses(
            styles.colorSwatch,
            value === null && styles.colorSwatchSelected,
          )}
          onClick={() => onSelect(null)}
        />
      )}
    </div>
  );
}
