"use client";

/**
 * The `⋯` overflow menu on a package row.
 *
 * Rows used to carry two competing outline buttons (Update and Remove) side by
 * side. In a 640px column with a scoped npm name that left neither button room
 * for its own label, and it gave a destructive action the same visual weight as
 * a routine one. Now the row keeps a single primary action and everything rare
 * or destructive lives behind here.
 */

import { motion } from "motion/react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@appica/ui-react/dropdown-menu";
import { MoreHorizontal } from "lucide-react";

export interface RowMenuItem {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  /** render in the danger tint and put it below a separator */
  danger?: boolean;
  disabled?: boolean;
}

export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <motion.button
            aria-label={label}
            title={label}
            whileTap={{ scale: 0.88 }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              flexShrink: 0,
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: "var(--text-tertiary)",
              cursor: "pointer",
            }}
          />
        }
      >
        <MoreHorizontal size={16} />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="material-thick"
        style={{
          minWidth: 190,
          padding: 6,
          border: "1px solid var(--separator)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 60,
        }}
      >
        {items.map((item, i) => (
          <div key={item.label}>
            {item.danger && i > 0 && (
              <DropdownMenuSeparator
                style={{ height: 1, margin: "5px 4px", background: "var(--separator)" }}
              />
            )}
            <DropdownMenuItem
              onClick={item.onSelect}
              disabled={item.disabled}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "7px 10px",
                borderRadius: 8,
                fontSize: 12.5,
                color: item.danger ? "var(--danger)" : "var(--text-secondary)",
                cursor: item.disabled ? "default" : "pointer",
                opacity: item.disabled ? 0.45 : 1,
              }}
            >
              <span style={{ display: "flex", flexShrink: 0, opacity: 0.75 }}>
                {item.icon}
              </span>
              {item.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
