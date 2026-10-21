(function () {
  "use strict";

  var STATUS_URL = "status.json";
  var REFRESH_INTERVAL_MS = 30000;
  var DEFAULT_STALE_SECONDS = 3600;
  var DEFAULT_OFFLINE_SECONDS = 21600;
  var MAX_CONSECUTIVE_FETCH_FAILURES = 3;

  var ALL_STATUSES = ["PASSED", "ONGOING", "PENDING", "FAILED", "BLOCKED", "SKIPPED"];

  var state = {
    data: null,
    consecutiveFailures: 0,
    lastSuccessfulFetch: null,
    activeStatusFilters: new Set(),
    searchTerm: ""
  };

  var els = {};

  function qs(id) { return document.getElementById(id); }

  function cacheEls() {
    els.freshness = qs("freshness");
    els.freshnessText = els.freshness.querySelector(".freshness-text");
    els.activeTask = qs("active-task");
    els.overallCounts = qs("overall-counts");
    els.missionList = qs("mission-list");
    els.evidence = qs("evidence");
    els.timelineList = qs("timeline-list");
    els.searchInput = qs("search-input");
    els.statusFilterRow = qs("status-filter-row");
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function formatAbsoluteUtc(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown time";
    return d.toISOString().replace(".000Z", "Z").replace("T", " ") + " UTC";
  }

  function formatRelative(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown";
    var deltaSec = Math.round((Date.now() - d.getTime()) / 1000);
    var abs = Math.abs(deltaSec);
    var suffix = deltaSec >= 0 ? "ago" : "from now";
    var units = [
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
      ["second", 1]
    ];
    for (var i = 0; i < units.length; i++) {
      var unitSeconds = units[i][1];
      if (abs >= unitSeconds || units[i][0] === "second") {
        var value = Math.floor(abs / unitSeconds);
        if (value >= 1) {
          return value + " " + units[i][0] + (value === 1 ? "" : "s") + " " + suffix;
        }
      }
    }
    return "just now";
  }

  function buildStatusFilterChips() {
    els.statusFilterRow.innerHTML = "";
    ALL_STATUSES.forEach(function (status) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-chip";
      btn.textContent = status;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", function () {
        if (state.activeStatusFilters.has(status)) {
          state.activeStatusFilters.delete(status);
          btn.setAttribute("aria-pressed", "false");
        } else {
          state.activeStatusFilters.add(status);
          btn.setAttribute("aria-pressed", "true");
        }
        applyFilters();
      });
      els.statusFilterRow.appendChild(btn);
    });
  }

  function statusBadge(status) {
    return (
      '<span class="status-badge" data-status="' + escapeHtml(status) + '">' +
      '<span class="dot" aria-hidden="true"></span>' + escapeHtml(status) +
      "</span>"
    );
  }

  function renderActiveTask(data) {
    var active = data.active;
    if (!active) {
      els.activeTask.innerHTML = '<p class="muted">No active task reported.</p>';
      return;
    }
    els.activeTask.innerHTML =
      '<div>' +
        '<div class="active-task-id">' + escapeHtml(active.taskId) + "</div>" +
        '<div class="active-task-title">' + escapeHtml(active.title) + "</div>" +
      "</div>" +
      statusBadge(active.status) +
      '<div class="active-task-meta">' +
        (active.model ? "<span>Model: " + escapeHtml(active.model) + "</span>" : "") +
        (active.since ? "<span>Since " + escapeHtml(formatAbsoluteUtc(active.since)) + "</span>" : "") +
      "</div>";
  }

  function renderOverallCounts(data) {
    var overall = data.overall || {};
    var total = overall.total || 0;
    var html = "";
    ALL_STATUSES.concat(["total"]).forEach(function () {});
    var tileOrder = ["passed", "ongoing", "pending", "failed", "blocked", "skipped"];
    tileOrder.forEach(function (key) {
      html +=
        '<div class="count-tile">' +
          '<div class="count-value">' + (overall[key] || 0) + "</div>" +
          '<div class="count-label">' + key + "</div>" +
        "</div>";
    });
    html +=
      '<div class="progress-bar-wrap">' +
        '<div class="progress-bar" role="img" aria-label="Overall progress: ' +
          tileOrder.map(function (k) { return (overall[k] || 0) + " " + k; }).join(", ") +
          ' out of ' + total + ' total.">' +
          tileOrder.map(function (k) {
            var pct = total > 0 ? ((overall[k] || 0) / total * 100) : 0;
            return '<div class="progress-seg" data-status="' + k.toUpperCase() + '" style="width:' + pct + '%"></div>';
          }).join("") +
        "</div>" +
      "</div>";
    els.overallCounts.innerHTML = html;
  }

  function taskMatchesFilters(task) {
    if (state.activeStatusFilters.size > 0 && !state.activeStatusFilters.has(task.status)) {
      return false;
    }
    if (state.searchTerm) {
      var haystack = (task.id + " " + task.title + " " + (task.summary || "")).toLowerCase();
      if (haystack.indexOf(state.searchTerm) === -1) return false;
    }
    return true;
  }

  function renderMissions(data) {
    var missions = data.missions || [];
    var html = "";
    missions.forEach(function (mission) {
      var missionTaskCount = 0;
      var missionVisibleCount = 0;
      var phasesHtml = "";

      (mission.phases || []).forEach(function (phase) {
        var tasks = phase.tasks || [];
        var visibleTasks = tasks.filter(taskMatchesFilters);
        missionTaskCount += tasks.length;
        missionVisibleCount += visibleTasks.length;

        var tasksHtml = tasks.map(function (task) {
          var hidden = !taskMatchesFilters(task);
          return (
            '<li class="task-row" data-task-id="' + escapeHtml(task.id) + '"' + (hidden ? " hidden" : "") + ">" +
              '<span class="task-id">' + escapeHtml(task.id) + "</span>" +
              '<span class="task-title">' + escapeHtml(task.title) + "</span>" +
              statusBadge(task.status) +
              (task.summary ? '<span class="task-summary">' + escapeHtml(task.summary) + "</span>" : "") +
            "</li>"
          );
        }).join("");

        var c = phase.counts || {};
        phasesHtml +=
          '<div class="phase-block">' +
            '<div class="phase-header">' +
              '<h3 class="phase-title">' + escapeHtml(phase.title) + "</h3>" +
              '<span class="phase-counts">' +
                (c.passed || 0) + " passed · " + (c.ongoing || 0) + " ongoing · " + (c.pending || 0) + " pending" +
                ((c.failed || 0) ? " · " + c.failed + " failed" : "") +
                ((c.blocked || 0) ? " · " + c.blocked + " blocked" : "") +
                ((c.skipped || 0) ? " · " + c.skipped + " skipped" : "") +
              "</span>" +
            "</div>" +
            (visibleTasks.length === 0
              ? '<p class="no-match-note">No tasks in this phase match the current filter.</p>'
              : '<ul class="task-grid">' + tasksHtml + "</ul>") +
          "</div>";
      });

      html +=
        '<article class="mission-card">' +
          '<div class="mission-header">' +
            '<h3 class="mission-title">' + escapeHtml(mission.title) + "</h3>" +
            '<span class="mission-counts">' + missionVisibleCount + " of " + missionTaskCount + " tasks shown</span>" +
            (mission.summary ? '<p class="mission-summary">' + escapeHtml(mission.summary) + "</p>" : "") +
          "</div>" +
          phasesHtml +
        "</article>";
    });
    els.missionList.innerHTML = html || '<p class="muted">No mission data available.</p>';
  }

  function applyFilters() {
    if (state.data) renderMissions(state.data);
  }

  function renderEvidence(data) {
    var html = "";
    html +=
      '<div class="evidence-card">' +
        "<h3>Latest approved checkpoint</h3>" +
        '<p class="checkpoint-sha">' + escapeHtml(data.sourceCheckpoint || "unknown") + "</p>" +
      "</div>";
    (data.tests || []).forEach(function (test) {
      html +=
        '<div class="evidence-card">' +
          "<h3>" + escapeHtml(test.label) + "</h3>" +
          '<p>' + escapeHtml(test.note || "") + (test.date ? " (" + escapeHtml(test.date) + ")" : "") + "</p>" +
        "</div>";
    });
    els.evidence.innerHTML = html;
  }

  function renderTimeline(data) {
    var items = data.timeline || [];
    if (items.length === 0) {
      els.timelineList.innerHTML = '<li class="muted">No activity recorded yet.</li>';
      return;
    }
    els.timelineList.innerHTML = items.map(function (item) {
      return (
        '<li class="timeline-item">' +
          '<div class="timeline-time">' + escapeHtml(formatAbsoluteUtc(item.timestamp)) + "</div>" +
          '<div class="timeline-event">' + escapeHtml(item.event) +
            (item.status ? " " + statusBadge(item.status) : "") +
          "</div>" +
          (item.taskId ? '<div class="timeline-task">' + escapeHtml(item.taskId) + "</div>" : "") +
        "</li>"
      );
    }).join("");
  }

  function updateFreshnessUi() {
    if (!state.data) return;
    var data = state.data;
    var staleAfter = (data.staleAfterSeconds || DEFAULT_STALE_SECONDS) * 1000;
    var offlineAfter = (data.offlineAfterSeconds || DEFAULT_OFFLINE_SECONDS) * 1000;
    var generatedAt = new Date(data.generatedAt).getTime();
    var age = Date.now() - generatedAt;

    var fetchFailuresExceeded = state.consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES;
    var dataExpired = age > offlineAfter;

    var uiState, text;
    if (fetchFailuresExceeded || dataExpired) {
      uiState = "offline";
      text = "OFFLINE — " + (fetchFailuresExceeded
        ? "repeated attempts to load the latest status failed."
        : "the status feed has not updated in over " + Math.round(offlineAfter / 3600000) + " hour(s).");
    } else if (age > staleAfter) {
      uiState = "stale";
      text = "STALE — last update " + formatRelative(data.generatedAt) + " (" + formatAbsoluteUtc(data.generatedAt) + ").";
    } else {
      uiState = "live";
      text = "LIVE FEED — status snapshot published " + formatRelative(data.generatedAt) + " (" + formatAbsoluteUtc(data.generatedAt) + ").";
    }

    els.freshness.setAttribute("data-state", uiState);
    els.freshnessText.textContent = text;
  }

  function renderAll() {
    var data = state.data;
    if (!data) return;
    renderActiveTask(data);
    renderOverallCounts(data);
    renderMissions(data);
    renderEvidence(data);
    renderTimeline(data);
    updateFreshnessUi();
  }

  function fetchStatus() {
    var url = STATUS_URL + "?t=" + Date.now();
    fetch(url, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        state.data = data;
        state.consecutiveFailures = 0;
        state.lastSuccessfulFetch = Date.now();
        renderAll();
      })
      .catch(function () {
        state.consecutiveFailures += 1;
        updateFreshnessUi();
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES && !state.data) {
          els.freshness.setAttribute("data-state", "offline");
          els.freshnessText.textContent = "OFFLINE — unable to load the status feed.";
          els.activeTask.innerHTML = '<p class="muted">Status feed unavailable.</p>';
          els.overallCounts.innerHTML = '<p class="muted">Status feed unavailable.</p>';
          els.missionList.innerHTML = '<p class="muted">Status feed unavailable.</p>';
        }
      });
  }

  function wireControls() {
    els.searchInput.addEventListener("input", function (e) {
      state.searchTerm = e.target.value.trim().toLowerCase();
      applyFilters();
    });
  }

  function tickFreshnessOnly() {
    updateFreshnessUi();
  }

  function init() {
    cacheEls();
    buildStatusFilterChips();
    wireControls();
    fetchStatus();
    setInterval(fetchStatus, REFRESH_INTERVAL_MS);
    setInterval(tickFreshnessOnly, 15000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
