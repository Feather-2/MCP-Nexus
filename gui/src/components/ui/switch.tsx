import * as React from "react"

import { cn } from "@/lib/utils"

export interface SwitchProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  onCheckedChange?: (checked: boolean) => void
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, onCheckedChange, ...props }, ref) => {
    function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
      onCheckedChange?.(event.target.checked)
      props.onChange?.(event)
    }

    return (
      <label className={cn("relative inline-flex h-6 w-10 cursor-pointer", className)}>
        <input
          type="checkbox"
          className="peer sr-only"
          ref={ref}
          onChange={handleChange}
          {...props}
        />
        <span className="absolute inset-0 rounded-full bg-muted transition peer-checked:bg-primary" />
        <span className="pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-background shadow transition peer-checked:translate-x-4" />
      </label>
    )
  },
)

Switch.displayName = "Switch"

export default Switch
