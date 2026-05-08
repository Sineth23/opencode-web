// Test script for OpenCode session creation
console.log('=== OpenCode Session Creation Test ===\n');

// Step 1: Get token
const token = localStorage.getItem('cognito_id_token');
console.log('1. Token available:', !!token);

if (!token) {
  console.error('❌ No token found. Please log in first.');
} else {
  // Step 2: Make POST /session request
  console.log('\n2. Making POST /session request...');
  const apiUrl = 'https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com/session';

  fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({})
  })
  .then(r => {
    console.log('   Response status:', r.status);
    return r.json();
  })
  .then(d => {
    console.log('   Response data:', JSON.stringify(d, null, 2));

    if (d.ok && d.sessionId) {
      console.log('\n✅ SUCCESS! Session created:');
      console.log('   sessionId:', d.sessionId);
      console.log('   taskArn:', d.taskArn);
      console.log('   password:', d.password.substring(0, 10) + '...');
    } else if (d.error) {
      console.log('\n❌ Error:', d.error);
    }
  })
  .catch(e => {
    console.error('\n❌ Request failed:', e.message);
  });
}
