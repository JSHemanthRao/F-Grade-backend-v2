const MODULE_DEFINITIONS = [
  { key: 'leads', label: 'Leads', endpoint: 'Leads', defaultFields: ['First_Name', 'Last_Name', 'Company', 'Email', 'Phone', 'Lead_Source', 'Created_Time'] },
  { key: 'contacts', label: 'Contacts', endpoint: 'Contacts', defaultFields: ['First_Name', 'Last_Name', 'Email', 'Phone', 'Mailing_City', 'Mailing_Country'] },
  { key: 'accounts', label: 'Accounts', endpoint: 'Accounts', defaultFields: ['Account_Name', 'Website', 'Phone', 'Industry', 'Annual_Revenue', 'Billing_Country'] },
  { key: 'deals', label: 'Deals', endpoint: 'Deals', defaultFields: ['Deal_Name', 'Amount', 'Stage', 'Closing_Date', 'Account_Name', 'Deal_Source', 'Owner'] },
  { key: 'tasks', label: 'Tasks', endpoint: 'Tasks', defaultFields: ['Subject', 'Status', 'Due_Date', 'Owner', 'Priority'] },
  { key: 'events', label: 'Events', endpoint: 'Events', defaultFields: ['Subject', 'Start_DateTime', 'End_DateTime', 'Owner', 'Location'] },
  { key: 'calls', label: 'Calls', endpoint: 'Calls', defaultFields: ['Subject', 'Call_Type', 'Call_Duration', 'Call_Start_Time', 'Status'] },
  { key: 'meetings', label: 'Meetings', endpoint: 'Meetings', defaultFields: ['Subject', 'Start_DateTime', 'End_DateTime', 'Owner', 'Related_To'] },
  { key: 'notes', label: 'Notes', endpoint: 'Notes', defaultFields: ['Title', 'Note_Content', 'Parent_Id', 'Owner'] },
  { key: 'products', label: 'Products', endpoint: 'Products', defaultFields: ['Product_Name', 'Product_Code', 'Unit_Price', 'Description'] },
  { key: 'vendors', label: 'Vendors', endpoint: 'Vendors', defaultFields: ['Vendor_Name', 'Email', 'Phone', 'City', 'State', 'Country'] },
  { key: 'quotes', label: 'Quotes', endpoint: 'Quotes', defaultFields: ['Subject', 'Quote_Number', 'Grand_Total', 'Status', 'Potential_Name'] },
  { key: 'sales-orders', label: 'Sales Orders', endpoint: 'Sales_Orders', defaultFields: ['Subject', 'Sales_Order_Number', 'Grand_Total', 'Status', 'Account_Name'] },
  { key: 'purchase-orders', label: 'Purchase Orders', endpoint: 'Purchase_Orders', defaultFields: ['Subject', 'Purchase_Order_Number', 'Grand_Total', 'Status', 'Vendor_Name'] },
  { key: 'campaigns', label: 'Campaigns', endpoint: 'Campaigns', defaultFields: ['Campaign_Name', 'Type', 'Status', 'Start_Date', 'End_Date'] },
  { key: 'cases', label: 'Cases', endpoint: 'Cases', defaultFields: ['Subject', 'Status', 'Priority', 'Origin', 'Account_Name'] },
  { key: 'solutions', label: 'Solutions', endpoint: 'Solutions', defaultFields: ['Solution_Title', 'Solution_Number', 'Status', 'IsPublished'] },
  { key: 'users', label: 'Users', endpoint: 'Users', defaultFields: ['first_name', 'last_name', 'email', 'role'] },
  { key: 'organization', label: 'Organization', endpoint: 'org', defaultFields: ['Company_Name', 'Alias', 'Primary_Email'] },
  { key: 'partners', label: 'Partners', endpoint: 'Partners', defaultFields: ['Partner_Name', 'Company_Name', 'Partner_Owner', 'Partner_Status', 'Email', 'Created_Time', 'Modified_Time', 'Last_Activity_Time', 'End_Customer_Accounts', 'id'] },
  { key: 'enterprise-leads', label: 'Enterprise Leads', endpoint: 'Enterprise', defaultFields: ['Enterprise_Name', 'Email', 'Enterprise_Owner', 'Modified_Time', 'Created_Time', 'Created_By', 'Connected_To', 'id'] },
  { key: 'renewal-accounts', label: 'Renewal Accounts', endpoint: 'Renewal_Accounts', defaultFields: ['Account_Name', 'Renewal_Date', 'Status', 'Owner'] },
  { key: 'service-provider', label: 'Service Provider', endpoint: 'Service_Provider', defaultFields: ['Service_Provider_Name', 'Email', 'Phone', 'Website'] },
  { key: 'co-operative-banks', label: 'Co-operative Banks', endpoint: 'Co_operative_Banks', defaultFields: ['Co_operative_Banks_Name', 'Contact_Name', 'Contact_Number', 'State_UT'] },
  { key: 'documents', label: 'Documents', endpoint: 'Documents', defaultFields: ['Title', 'File_Name', 'Owner', 'Created_Time'] },
];

const MODULE_INDEX = MODULE_DEFINITIONS.reduce((index, moduleDefinition) => {
  index[moduleDefinition.key] = moduleDefinition;
  return index;
}, {});

function getModuleDefinitions() {
  return MODULE_DEFINITIONS;
}

function getModuleDefinition(moduleKey) {
  return MODULE_INDEX[moduleKey] || null;
}

function getSupportedModuleKeys() {
  return MODULE_DEFINITIONS.map((moduleDefinition) => moduleDefinition.key);
}

module.exports = {
  getModuleDefinitions,
  getModuleDefinition,
  getSupportedModuleKeys,
};
