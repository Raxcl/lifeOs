// LifeOS 各页面共用的纯工具函数。
// 通过 window.LifeOSShared 暴露，需在各页面主脚本之前引入。
(() => {
  function formatDate(dateObject) {
    const year = dateObject.getFullYear();
    const month = String(dateObject.getMonth() + 1).padStart(2, "0");
    const day = String(dateObject.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseDateKey(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function isDateKey(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    return formatDate(parseDateKey(value)) === value;
  }

  function isMonthKey(value) {
    return /^\d{4}-\d{2}$/.test(String(value || ""));
  }

  function normaliseDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? value : "";
  }

  function weekdayLabel(dateObject) {
    return `周${"日一二三四五六"[dateObject.getDay()]}`;
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function toErrorMessage(error) {
    if (!error) return "出现未知错误";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return "操作失败";
    }
  }

  function defaultHabitDefinitions() {
    return [
      { id: "habit-journal", label: "写了晨间日记" },
      { id: "habit-focus", label: "推进了核心任务" },
      { id: "habit-review", label: "晚上做了简短回看" }
    ];
  }

  window.LifeOSShared = {
    formatDate,
    parseDateKey,
    isDateKey,
    isMonthKey,
    normaliseDate,
    weekdayLabel,
    nowSeconds,
    escapeHtml,
    toErrorMessage,
    defaultHabitDefinitions
  };
})();
