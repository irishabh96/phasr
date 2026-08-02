import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { StrategyRadioGroup } from "@/components/ui/StrategyRadioGroup";

const OPTIONS = [
  { value: "merge", label: "Merge commit", hint: "no-ff merge" },
  { value: "squash", label: "Squash", hint: "one commit" },
  { value: "fastForward", label: "Fast-forward", hint: "move the ref" },
] as const;

function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState<(typeof OPTIONS)[number]["value"]>("merge");
  return (
    <StrategyRadioGroup
      legend="Strategy"
      options={OPTIONS}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe("StrategyRadioGroup", () => {
  it("is a real radiogroup: roles, checked state, ONE tab stop", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    // Roving tabindex: only the selection is tabbable.
    expect(radios[0]).toHaveAttribute("tabindex", "0");
    expect(radios[1]).toHaveAttribute("tabindex", "-1");
    expect(radios[2]).toHaveAttribute("tabindex", "-1");
  });

  it("arrows move BOTH selection and focus, wrapping; Home/End jump", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const radios = () => screen.getAllByRole("radio");

    radios()[0]!.focus();
    fireEvent.keyDown(radios()[0]!, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("squash");
    expect(radios()[1]).toHaveAttribute("aria-checked", "true");
    expect(radios()[1]).toHaveFocus();

    // Wraps from the last back to the first.
    fireEvent.keyDown(radios()[1]!, { key: "ArrowDown" });
    fireEvent.keyDown(radios()[2]!, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("merge");
    expect(radios()[0]).toHaveFocus();

    fireEvent.keyDown(radios()[0]!, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("fastForward");
    fireEvent.keyDown(radios()[2]!, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("merge");
  });

  it("click selects; disabled dims and blocks the whole group", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /Squash/ }));
    expect(onChange).toHaveBeenLastCalledWith("squash");

    rerender(
      <StrategyRadioGroup
        legend="Strategy"
        options={OPTIONS}
        value="merge"
        onChange={onChange}
        disabled
      />,
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });
});
