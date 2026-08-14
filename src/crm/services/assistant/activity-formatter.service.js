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
    };
  }

  const data = Array.isArray(activityResult.data) ? activityResult.data : [];

  if (data.length === 0) {
    return {
      success: true,
      summary: 'No CRM activity was found for today.',
      data: [],
      tables: [],
    };
  }

  const users = [...new Set(data.map((item) => item.user_name).filter(Boolean))];
  const isSingleUser = users.length === 1;

  // Intro phrase
  const intro = isSingleUser
    ? `${users[0]} completed the following CRM activities today.`
    : 'The following CRM activities were completed today.';

  // Build detail table rows
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

  // Calculate user-level summary stats
  const userStatsMap = new Map();
  users.forEach((userName) => {
    userStatsMap.set(userName, {
      dealsCreated: 0,
      meetingsCreated: 0,
      notesAdded: 0,
      otherChanges: 0,
    });
  });

  data.forEach((item) => {
    const user = item.user_name || 'Unknown';
    if (!userStatsMap.has(user)) {
      userStatsMap.set(user, { dealsCreated: 0, meetingsCreated: 0, notesAdded: 0, otherChanges: 0 });
    }
    const stats = userStatsMap.get(user);
    const type = String(item.activity_type || '').toLowerCase();

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

  // Construct natural language summary sentences
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

  // Check if user specifically requested a summary table
  const wantsSummaryTable = /summary|overview|breakdown|aggregate/i.test(question);

  // Build markdown representation
  const markdownLines = [];
  markdownLines.push("Today's CRM Activity");
  markdownLines.push('');
  markdownLines.push(intro);
  markdownLines.push('');

  // Primary Detail Table
  markdownLines.push(`| ${detailHeaders.join(' | ')} |`);
  markdownLines.push(`| ${detailHeaders.map(() => '---').join(' | ')} |`);
  detailRows.forEach((row) => {
    markdownLines.push(`| ${row.join(' | ')} |`);
  });

  markdownLines.push('');
  if (summarySentences.length > 0) {
    markdownLines.push(summarySentences.join('\n'));
  }

  // Summary Table if requested
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

  if (wantsSummaryTable && summaryRows.length > 0) {
    markdownLines.push('');
    markdownLines.push(`| ${summaryHeaders.join(' | ')} |`);
    markdownLines.push('|---|---:|---:|---:|---:|');
    summaryRows.forEach((row) => {
      markdownLines.push(`| ${row.join(' | ')} |`);
    });
  }

  const formattedText = markdownLines.join('\n');

  return {
    success: true,
    summary: formattedText,
    data,
    tables: [
      { title: "Today's CRM Activity", headers: detailHeaders, rows: detailRows },
      ...(wantsSummaryTable ? [{ title: 'Activity Summary', headers: summaryHeaders, rows: summaryRows }] : []),
    ],
  };
}

module.exports = {
  formatActivityResponse,
  formatTimeString,
};
