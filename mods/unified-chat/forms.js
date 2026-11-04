// Mirrors OpenCode V2's field types and ordered conditional visibility. The
// server remains authoritative; answers are never submitted by discovery.
export function activeFields(form, answers) {
  const preceding = {};
  return form.fields.filter((field) => {
    if (field.hidden) return false;
    const active = (field.when ?? []).every((condition) => {
      const value = preceding[condition.key];
      if (value === undefined) return false;
      const hit = Array.isArray(value) ? value.includes(condition.value) : value === condition.value;
      return condition.op === "eq" ? hit : !hit;
    });
    if (active) preceding[field.key] = answers[field.key];
    return active;
  });
}

export function fieldError(field, value) {
  if (field.type === "external") return value === true ? null : "Acknowledge completion of the external action.";
  if (value === undefined) return field.required ? "Answer required." : null;
  if (field.required && (value === "" || (Array.isArray(value) && !value.length))) return "Answer required.";
  if (field.type === "string") {
    if (typeof value !== "string") return "Expected text.";
    if (field.minLength != null && value.length < field.minLength) return `At least ${field.minLength} characters required.`;
    if (field.maxLength != null && value.length > field.maxLength) return `At most ${field.maxLength} characters allowed.`;
    if (field.pattern) { try { if (!new RegExp(field.pattern).test(value)) return `Must match ${field.pattern}`; } catch { return "Invalid field pattern."; } }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Expected an email address.";
    if (field.format === "uri") { try { new URL(value); } catch { return "Expected a URL."; } }
    if (field.format === "date") {
      const date = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return "Expected YYYY-MM-DD.";
    }
    if (field.format === "date-time" && !Number.isFinite(new Date(value).getTime())) return "Expected a date and time.";
    if (field.options && !field.custom && !field.options.some((option) => option.value === value)) return "Select an available option.";
    return null;
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Expected a finite number.";
    if (field.type === "integer" && !Number.isInteger(value)) return "Expected an integer.";
    if (typeof field.minimum === "number" && value < field.minimum) return `Minimum: ${field.minimum}`;
    if (typeof field.maximum === "number" && value > field.maximum) return `Maximum: ${field.maximum}`;
    return null;
  }
  if (field.type === "boolean") return typeof value === "boolean" ? null : "Expected yes or no.";
  if (field.type === "multiselect") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return "Expected a list of choices.";
    if (field.minItems != null && value.length < field.minItems) return `Select at least ${field.minItems}.`;
    if (field.maxItems != null && value.length > field.maxItems) return `Select at most ${field.maxItems}.`;
    if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item))) return "Select only available choices.";
    return null;
  }
  return "Unsupported field type. Keep the native prompt available.";
}

export function formAnswer(form, answers) {
  const output = {};
  for (const field of activeFields(form, answers)) {
    const error = fieldError(field, answers[field.key]);
    if (error) throw new Error(`${field.title ?? field.key}: ${error}`);
    if (answers[field.key] !== undefined) output[field.key] = answers[field.key];
  }
  return output;
}
