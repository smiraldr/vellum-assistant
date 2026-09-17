/**
 * A table of rows under column headers, with a copy-as-markdown control and
 * optional row selection. Presentational: it draws what it is given and owns
 * its own prop types, so a consumer maps its data (a `ui_show` table surface,
 * a tool result) to these props at its own boundary.
 */

import { Check, Copy } from "lucide-react";
import { useCallback, type ReactNode } from "react";

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

import { SelectionIndicator } from "@/domains/chat/components/surfaces/selection-indicator";

export interface DataTableColumn {
  id: string;
  label: string;
  /** Fixed width in px. Unset columns share the remaining width. */
  width?: number;
}

/** A cell's text, optionally led by an icon the consumer has already drawn. */
export interface DataTableRichCell {
  text: string;
  icon?: ReactNode;
}

export type DataTableCell = string | DataTableRichCell;

export interface DataTableRow {
  id: string;
  /** Cells keyed by column id. A missing key renders empty. */
  cells: Record<string, DataTableCell>;
  /** Whether this row can be selected when the table has a selection. */
  selectable?: boolean;
}

export interface DataTableSelection {
  mode: "single" | "multiple";
  selectedIds: readonly string[];
  onToggle: (rowId: string) => void;
}

export interface DataTableProps {
  columns: readonly DataTableColumn[];
  rows: readonly DataTableRow[];
  caption?: string;
  /** Row selection, when the table is a choice rather than a readout. */
  selection?: DataTableSelection;
}

function cellText(cell: DataTableCell | undefined): string {
  if (cell === undefined) {
    return "";
  }
  return typeof cell === "string" ? cell : cell.text;
}

function escapeMd(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The table as GitHub-flavored markdown, for the copy control. */
export function tableToMarkdown(
  columns: readonly DataTableColumn[],
  rows: readonly DataTableRow[],
): string {
  const header =
    "| " + columns.map((c) => escapeMd(c.label)).join(" | ") + " |";
  const separator = "| " + columns.map(() => "---").join(" | ") + " |";
  const body = rows.map(
    (row) =>
      "| " +
      columns.map((col) => escapeMd(cellText(row.cells[col.id]))).join(" | ") +
      " |",
  );
  return [header, separator, ...body].join("\n");
}

export function DataTable({
  columns,
  rows,
  caption,
  selection,
}: DataTableProps) {
  const { t } = useTranslation("chat");
  const { copy, copied } = useCopyToClipboard({
    errorMessage: "Couldn't copy the table.",
  });
  const handleCopy = useCallback(
    () => copy(tableToMarkdown(columns, rows)),
    [copy, columns, rows],
  );

  return (
    <div data-owns-horizontal-scroll="" className="overflow-x-auto">
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded p-1 text-body-small-default text-[var(--content-quiet)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
          aria-label={t("tableSurface.copyAria")}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? t("tableSurface.copied") : t("tableSurface.copy")}
        </button>
      </div>
      <table className="w-full text-left text-body-medium-lighter">
        <thead>
          <tr className="border-b border-[var(--border-subtle)]">
            {selection && <th className="w-10 px-3 py-2" />}
            {columns.map((col) => (
              <th
                key={col.id}
                className="px-3 py-2 text-body-small-default text-[var(--content-quiet)]"
                style={col.width ? { width: `${col.width}px` } : undefined}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-base)]">
          {rows.map((row) => {
            const isSelected =
              selection !== undefined && selection.selectedIds.includes(row.id);
            const rowSelectable =
              selection !== undefined && row.selectable !== false;

            return (
              <tr
                key={row.id}
                onClick={() => rowSelectable && selection.onToggle(row.id)}
                className={cn(
                  "transition-colors",
                  rowSelectable &&
                    "cursor-pointer hover:bg-[var(--surface-hover)]",
                  isSelected && "bg-[var(--system-positive-weak)]",
                )}
              >
                {selection && (
                  <td className="px-3 py-2">
                    {rowSelectable && (
                      <SelectionIndicator
                        selected={isSelected}
                        single={selection.mode === "single"}
                      />
                    )}
                  </td>
                )}
                {columns.map((col) => {
                  const cell = row.cells[col.id];
                  return (
                    <td
                      key={col.id}
                      className="px-3 py-2 text-[var(--content-default)]"
                      style={
                        col.width ? { width: `${col.width}px` } : undefined
                      }
                    >
                      {typeof cell === "object" && cell.icon ? (
                        <span className="flex items-center gap-1.5">
                          {cell.icon}
                          {cell.text}
                        </span>
                      ) : (
                        cellText(cell)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {caption && (
        <p className="mt-2 text-body-small-default text-[var(--content-quiet)]">
          {caption}
        </p>
      )}
    </div>
  );
}
