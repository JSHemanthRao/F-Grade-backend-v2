function formatTimeString(isoString) {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.valueOf())) return String(isoString);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch (e) {
    return String(isoString);
  }
}

function capitalize(str) {
  if (!str) return '';
  return String(str).charAt(0).toUpperCase() + String(str).slice(1);
}

function formatActivityResponse(activityResult, { question = '' } = {}) {
  if (!activityResult || activityResult.success === false) {
    return {
      success: false,
      summary: 'No activity could be retrieved because the CRM activity API returned an error.',
      error: activityResult?.error || 'CRM_ACTIVITY_API_ERROR',
      data: [],
      tables: [],
      dashboard: null,
    };
  }

  const data = Array.isArray(activityResult.data) ? activityResult.data : [];

  if (data.length === 0) {
    return {
      success: true,
      summary: 'No CRM activity was found for today.',
      data: [],
      tables: [],
      dashboard: null,
    };
  }

  const users = [...new Set(data.map((item) => item.user_name).filter(Boolean))];
  const isSingleUser = users.length === 1;

  // SECTION 1: Detailed activity table
  const intro = isSingleUser
    ? `${users[0]} completed the following CRM activities today.`
    : 'The following CRM activities were completed today.';

  const detailHeaders = ['Employee', 'Activity', 'Module', 'Record', 'Action', 'Time'];
  const detailRows = data.map((item) => {
    const activityText = `${capitalize(item.activity_type || item.module)} ${item.action || 'created'}`;
    const actionText = capitalize(item.action || 'created');
    const timeText = formatTimeString(item.audited_time);

    return [
      item.user_name || 'Unknown',
      activityText,
      item.module || item.module_api_name || 'Deals',
      item.record_name || 'Untitled Record',
      actionText,
      timeText,
    ];
  });

  // Calculate stats for Summary and Dashboard
  const userStatsMap = new Map();
  users.forEach((userName) => {
    userStatsMap.set(userName, {
      dealsCreated: 0,
      meetingsCreated: 0,
      notesAdded: 0,
      otherChanges: 0,
    });
  });

  const modMap = {};
  const actMap = {};

  data.forEach((item) => {
    const user = item.user_name || 'Unknown';
    if (!userStatsMap.has(user)) {
      userStatsMap.set(user, { dealsCreated: 0, meetingsCreated: 0, notesAdded: 0, otherChanges: 0 });
    }
    const stats = userStatsMap.get(user);
    const type = String(item.activity_type || '').toLowerCase();
    const action = String(item.action || '').toLowerCase();
    const mod = item.module || 'Deals';

    modMap[mod] = (modMap[mod] || 0) + 1;
    actMap[action] = (actMap[action] || 0) + 1;

    if (type === 'deal') {
      stats.dealsCreated += 1;
    } else if (type === 'meeting') {
      stats.meetingsCreated += 1;
    } else if (type === 'note') {
      stats.notesAdded += 1;
    } else {
      stats.otherChanges += 1;
    }
  });

  const summarySentences = [];
  userStatsMap.forEach((stats, user) => {
    const parts = [];
    if (stats.dealsCreated > 0) parts.push(`created ${stats.dealsCreated} deal${stats.dealsCreated > 1 ? 's' : ''}`);
    if (stats.meetingsCreated > 0) parts.push(`created ${stats.meetingsCreated} meeting${stats.meetingsCreated > 1 ? 's' : ''}`);
    if (stats.notesAdded > 0) parts.push(`added ${stats.notesAdded} note${stats.notesAdded > 1 ? 's' : ''}`);
    if (stats.otherChanges > 0) parts.push(`made ${stats.otherChanges} other change${stats.otherChanges > 1 ? 's' : ''}`);

    if (parts.length > 0) {
      summarySentences.push(`Today, ${user} ${parts.join(', ')}.`);
    }
  });

  const totalDeals = Array.from(userStatsMap.values()).reduce((sum, s) => sum + s.dealsCreated, 0);
  const totalMeetings = Array.from(userStatsMap.values()).reduce((sum, s) => sum + s.meetingsCreated, 0);
  const totalNotes = Array.from(userStatsMap.values()).reduce((sum, s) => sum + s.notesAdded, 0);
  const totalOther = Array.from(userStatsMap.values()).reduce((sum, s) => sum + s.otherChanges, 0);

  // Markdown representation
  const markdownLines = [];
  markdownLines.push("### Today's CRM Activity");
  markdownLines.push('');
  markdownLines.push(intro);
  markdownLines.push('');

  // Section 1: Detailed Table
  markdownLines.push(`| ${detailHeaders.join(' | ')} |`);
  markdownLines.push(`| ${detailHeaders.map(() => '---').join(' | ')} |`);
  detailRows.forEach((row) => {
    markdownLines.push(`| ${row.join(' | ')} |`);
  });

  markdownLines.push('');
  if (summarySentences.length > 0) {
    markdownLines.push(summarySentences.join('\n'));
  }

  // Section 2: Aggregated Activity Dashboard Summary
  markdownLines.push('');
  markdownLines.push('### Activity Dashboard');
  markdownLines.push('');
  markdownLines.push(`- **Total Activities Logged**: ${data.length}`);
  markdownLines.push(`- **Deals Actioned**: ${totalDeals}`);
  markdownLines.push(`- **Meetings Logged**: ${totalMeetings}`);
  markdownLines.push(`- **Notes Added**: ${totalNotes}`);
  if (totalOther > 0) {
    markdownLines.push(`- **Other Changes**: ${totalOther}`);
  }

  const summaryHeaders = ['Employee', 'Deals Created', 'Meetings Created', 'Notes Added', 'Other Changes'];
  const summaryRows = [];
  userStatsMap.forEach((stats, user) => {
    summaryRows.push([
      user,
      String(stats.dealsCreated),
      String(stats.meetingsCreated),
      String(stats.notesAdded),
      String(stats.otherChanges),
    ]);
  });

  markdownLines.push('');
  markdownLines.push(`| ${summaryHeaders.join(' | ')} |`);
  markdownLines.push('|---|---:|---:|---:|---:|');
  summaryRows.forEach((row) => {
    markdownLines.push(`| ${row.join(' | ')} |`);
  });

  // Section 2 Dashboard Object
  const dashboard = {
    title: isSingleUser ? `${users[0]}'s Activity Dashboard` : "Today's CRM Activity Dashboard",
    type: 'activity',
    theme: { mode: 'light', primaryColor: '#2563EB', accentColor: '#14B8A6' },
    dateRange: { from: activityResult.date, to: activityResult.date },
    widgets: [
      {
        id: 'total-activities-kpi',
        type: 'kpi',
        title: 'Total Activities',
        value: data.length,
        formattedValue: String(data.length),
        subtitle: "Today's actions",
        icon: 'activity',
      },
      {
        id: 'deals-kpi',
        type: 'kpi',
        title: 'Deals Created/Updated',
        value: totalDeals,
        formattedValue: String(totalDeals),
        subtitle: 'Deal actions',
        icon: 'dollar',
      },
      {
        id: 'meetings-kpi',
        type: 'kpi',
        title: 'Meetings Logged',
        value: totalMeetings,
        formattedValue: String(totalMeetings),
        subtitle: 'Client meetings',
        icon: 'calendar',
      },
      {
        id: 'notes-kpi',
        type: 'kpi',
        title: 'Notes Added',
        value: totalNotes,
        formattedValue: String(totalNotes),
        subtitle: 'Notes on records',
        icon: 'file-text',
      },
      {
        id: 'activities-by-employee-bar',
        type: 'bar',
        title: 'Activities by Employee',
        data: summaryRows.map(([emp, d, m, n, o]) => ({
          label: emp,
          value: Number(d) + Number(m) + Number(n) + Number(o),
        })),
      },
      {
        id: 'activities-by-module-donut',
        type: 'donut',
        title: 'Activities by Module',
        data: Object.keys(modMap).map((k) => ({ label: k, value: modMap[k] })),
      },
    ],
  };

  const formattedText = markdownLines.join('\n');

  return {
    success: true,
    summary: formattedText,
    data,
    tables: [
      { title: "Today's CRM Activity", headers: detailHeaders, rows: detailRows },
      { title: 'Activity Summary', headers: summaryHeaders, rows: summaryRows },
    ],
    dashboard,
  };
}

module.exports = {
  formatActivityResponse,
  formatTimeString,
};
