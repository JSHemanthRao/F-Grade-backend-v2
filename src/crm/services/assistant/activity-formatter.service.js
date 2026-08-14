/**
 * CRM Activity Report Formatter
 * Adheres strictly to the CRM Activity Report Format rules and produces
 * formal management reports + activity dashboard specifications.
 */

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

function cleanBusinessAction(action, field, oldValue, newValue) {
  if (field && (oldValue || newValue)) {
    const fieldName = field.replace(/_/g, ' ');
    if (oldValue && newValue) {
      return `${fieldName} changed from ${oldValue} to ${newValue}`;
    }
    if (newValue) {
      return `${fieldName} set to ${newValue}`;
    }
  }

  const act = String(action || 'created').toLowerCase();
  if (act.includes('stage')) return 'Stage updated';
  if (act.includes('add') || act.includes('note')) return 'Note added';
  if (act.includes('meet') || act.includes('event')) return 'Meeting scheduled';
  if (act.includes('call')) return 'Call logged';
  if (act.includes('task')) return 'Task updated';
  if (act.includes('updat') || act.includes('edit') || act.includes('change')) return 'Record updated';
  if (act.includes('creat')) return 'Record created';
  return capitalize(act);
}

function cleanBusinessModule(moduleName) {
  const m = String(moduleName || 'Deals');
  if (/deluge|workflow|automation/i.test(m)) return 'Automation';
  if (/deal|potentials/i.test(m)) return 'Deals';
  if (/meeting|events/i.test(m)) return 'Meetings';
  if (/note/i.test(m)) return 'Notes';
  if (/call/i.test(m)) return 'Calls';
  if (/task/i.test(m)) return 'Tasks';
  if (/lead/i.test(m)) return 'Leads';
  if (/contact/i.test(m)) return 'Contacts';
  if (/account/i.test(m)) return 'Accounts';
  return capitalize(m.replace(/_/g, ' '));
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

  const rawData = Array.isArray(activityResult.data) ? activityResult.data : [];

  if (rawData.length === 0) {
    return {
      success: true,
      summary: 'No CRM activity was found for today.',
      data: [],
      tables: [],
      dashboard: null,
    };
  }

  // Deduplicate and group identical automation activities
  const humanActivities = [];
  const automationGroups = new Map();

  rawData.forEach((item) => {
    const isAutomation = /automation|system|deluge/i.test(item.source || item.user_name || item.module || '');
    if (isAutomation) {
      const key = `${item.module}_${item.action}_${item.record_name}`;
      if (!automationGroups.has(key)) {
        automationGroups.set(key, { ...item, count: 1 });
      } else {
        automationGroups.get(key).count += 1;
      }
    } else {
      humanActivities.push(item);
    }
  });

  const processedData = [
    ...humanActivities,
    ...Array.from(automationGroups.values()).map((ag) => ({
      ...ag,
      action: ag.count > 1 ? `${ag.action} (executed ${ag.count} times)` : ag.action,
      user_name: 'Automation',
    })),
  ];

  const humanUsers = [...new Set(humanActivities.map((item) => item.user_name).filter(Boolean))];
  const isSingleUser = humanUsers.length === 1;
  const singleUserName = humanUsers[0] || 'Employee';

  // 1. Report Header
  const reportDate = activityResult.date || new Date().toISOString().slice(0, 10);
  const header = isSingleUser
    ? `${singleUserName} - CRM Activity Report\n${reportDate}`
    : `CRM Daily Activity Report\n${reportDate}`;

  // 2. Executive Summary
  let dealsCreated = 0;
  let dealsUpdated = 0;
  let meetingsCreated = 0;
  let notesAdded = 0;
  let callsLogged = 0;
  let otherChanges = 0;

  humanActivities.forEach((item) => {
    const type = String(item.activity_type || '').toLowerCase();
    const act = String(item.action || '').toLowerCase();

    if (type === 'deal') {
      if (act.includes('creat')) dealsCreated += 1;
      else dealsUpdated += 1;
    } else if (type === 'meeting') {
      meetingsCreated += 1;
    } else if (type === 'note') {
      notesAdded += 1;
    } else if (type === 'call') {
      callsLogged += 1;
    } else {
      otherChanges += 1;
    }
  });

  const totalHumanActions = humanActivities.length;
  const execSummary = isSingleUser
    ? `${singleUserName} recorded ${totalHumanActions} CRM activities today, including ${dealsCreated + dealsUpdated} deal actions, ${meetingsCreated} meetings, and ${notesAdded} notes.`
    : `The team recorded ${totalHumanActions} total CRM activities today across ${humanUsers.length} team members, including ${dealsCreated + dealsUpdated} deal actions, ${meetingsCreated} meetings, and ${notesAdded} notes.`;

  // 3. Activity Table
  const detailHeaders = ['Employee', 'Time', 'Module', 'Activity', 'Record', 'Change/Outcome'];
  const detailRows = processedData.map((item) => {
    const emp = item.user_name || 'User';
    const timeStr = formatTimeString(item.audited_time || item.time);
    const mod = cleanBusinessModule(item.module || item.module_api_name);
    const actType = capitalize(item.activity_type || 'Record');
    const recName = item.record_name || 'Untitled Record';
    const outcome = cleanBusinessAction(item.action, item.field, item.old_value, item.new_value);

    return [emp, timeStr, mod, actType, recName, outcome];
  });

  // 4. Activity Summary Section
  const summaryList = [
    `Activity Summary`,
    `- Deals created: ${dealsCreated}`,
    `- Deals updated: ${dealsUpdated}`,
    `- Meetings created: ${meetingsCreated}`,
    `- Notes added: ${notesAdded}`,
    `- Calls: ${callsLogged}`,
    `- Other CRM changes: ${otherChanges}`,
  ].join('\n');

  // Markdown Assembly
  const markdownLines = [
    `# ${header}`,
    '',
    `> ${execSummary}`,
    '',
    `| ${detailHeaders.join(' | ')} |`,
    `| ${detailHeaders.map(() => '---').join(' | ')} |`,
    ...detailRows.map((row) => `| ${row.join(' | ')} |`),
    '',
    summaryList,
  ];

  // 5. Activity Dashboard Object
  const modCounts = {};
  processedData.forEach((d) => {
    const m = cleanBusinessModule(d.module);
    modCounts[m] = (modCounts[m] || 0) + 1;
  });

  const empCounts = {};
  humanActivities.forEach((d) => {
    const u = d.user_name || 'User';
    empCounts[u] = (empCounts[u] || 0) + 1;
  });

  const dashboard = {
    title: isSingleUser ? `${singleUserName} - CRM Activity Dashboard` : "Today's CRM Activity Dashboard",
    type: 'activity',
    theme: { mode: 'light', primaryColor: '#2563EB', accentColor: '#14B8A6' },
    dateRange: { from: reportDate, to: reportDate },
    filters: [
      { type: 'Employee', value: isSingleUser ? singleUserName : 'All Employees' },
      { type: 'Date', value: reportDate },
    ],
    summary: execSummary,
    widgets: [
      {
        id: 'total-activities-kpi',
        type: 'kpi',
        title: 'Total Activities',
        value: totalHumanActions,
        formattedValue: String(totalHumanActions),
        subtitle: "Today's user actions",
        icon: '⚡',
        accent: '#2563EB',
      },
      {
        id: 'deals-kpi',
        type: 'kpi',
        title: 'Deals Created / Updated',
        value: dealsCreated + dealsUpdated,
        formattedValue: String(dealsCreated + dealsUpdated),
        subtitle: `${dealsCreated} created, ${dealsUpdated} updated`,
        icon: '💼',
        accent: '#10B981',
      },
      {
        id: 'meetings-kpi',
        type: 'kpi',
        title: 'Meetings Logged',
        value: meetingsCreated,
        formattedValue: String(meetingsCreated),
        subtitle: 'Client & team meetings',
        icon: '📅',
        accent: '#6366F1',
      },
      {
        id: 'notes-kpi',
        type: 'kpi',
        title: 'Notes Added',
        value: notesAdded,
        formattedValue: String(notesAdded),
        subtitle: 'Customer record notes',
        icon: '📝',
        accent: '#F59E0B',
      },
      {
        id: 'activities-by-employee-bar',
        type: 'bar',
        title: 'Activities by Employee',
        subtitle: 'Actions per team member',
        data: Object.keys(empCounts).map((k) => ({ label: k, value: empCounts[k] })),
      },
      {
        id: 'activities-by-module-donut',
        type: 'donut',
        title: 'Activities by Module',
        subtitle: 'Distribution across CRM modules',
        data: Object.keys(modCounts).map((k) => ({ label: k, value: modCounts[k] })),
      },
      {
        id: 'activity-timeline',
        type: 'activity_timeline',
        title: 'Activity Timeline',
        subtitle: 'Chronological events stream',
        data: processedData.slice(0, 15).map((a) => ({
          id: a.record_id,
          user: a.user_name,
          action: cleanBusinessAction(a.action, a.field, a.old_value, a.new_value),
          module: cleanBusinessModule(a.module),
          recordName: a.record_name,
          time: a.audited_time || a.time,
          source: a.source,
        })),
      },
    ],
  };

  return {
    success: true,
    summary: markdownLines.join('\n'),
    data: processedData,
    tables: [
      { title: header, headers: detailHeaders, rows: detailRows },
    ],
    dashboard,
  };
}

module.exports = {
  formatActivityResponse,
  formatTimeString,
  cleanBusinessAction,
  cleanBusinessModule,
};
