const { ZohoAuthService } = require('../src/services/zohoAuth.service');

async function main() {
  try {
    const authService = new ZohoAuthService();
    await authService.getAccessToken();
    console.log('Zoho authentication succeeded.');
  } catch (error) {
    console.error(`Zoho authentication failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();