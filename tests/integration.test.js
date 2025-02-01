const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const API_URL = 'http://localhost:10000';
const TEST_PDF_PATH = path.join(__dirname, 'test.pdf');

// Test user credentials
const TEST_USER = {
  email: `test${Date.now()}@example.com`,
  password: 'Test123!@#',
  name: 'Test User'
};

let token = null;
let userId = null;
let resumeId = null;

// Create a proper test PDF
function createTestPDF() {
  const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog
   /Pages 2 0 R
>>
endobj

2 0 obj
<< /Type /Pages
   /Kids [3 0 R]
   /Count 1
>>
endobj

3 0 obj
<< /Type /Page
   /Parent 2 0 R
   /Resources << /Font << /F1 4 0 R >> >>
   /MediaBox [0 0 612 792]
   /Contents 5 0 R
>>
endobj

4 0 obj
<< /Type /Font
   /Subtype /Type1
   /BaseFont /Helvetica
>>
endobj

5 0 obj
<< /Length 44 >>
stream
BT
/F1 24 Tf
72 720 Td
(Test Resume) Tj
ET
endstream
endobj

xref
0 6
0000000000 65535 f
0000000010 00000 n
0000000063 00000 n
0000000125 00000 n
0000000247 00000 n
0000000325 00000 n

trailer
<< /Size 6
   /Root 1 0 R
>>
startxref
421
%%EOF`;

  fs.writeFileSync(TEST_PDF_PATH, pdfContent);
  console.log('Created test PDF at:', TEST_PDF_PATH);
}

// Test registration
async function testRegistration() {
  console.log('\n=== Testing Registration ===');
  try {
    const response = await axios.post(`${API_URL}/api/auth/register`, TEST_USER);
    console.log('Registration successful:', response.data);
    token = response.data.token;
    userId = response.data.user.id;
    return true;
  } catch (error) {
    console.error('Registration failed:', error.response?.data || error.message);
    return false;
  }
}

// Test login
async function testLogin() {
  console.log('\n=== Testing Login ===');
  try {
    const response = await axios.post(`${API_URL}/api/auth/login`, {
      email: TEST_USER.email,
      password: TEST_USER.password
    });
    console.log('Login successful:', response.data);
    token = response.data.token;
    userId = response.data.user.id;
    return true;
  } catch (error) {
    console.error('Login failed:', error.response?.data || error.message);
    return false;
  }
}

// Test resume upload
async function testResumeUpload() {
  console.log('\n=== Testing Resume Upload ===');
  try {
    // Verify test PDF exists
    if (!fs.existsSync(TEST_PDF_PATH)) {
      throw new Error('Test PDF file does not exist');
    }
    console.log('Test PDF exists at:', TEST_PDF_PATH);
    console.log('Test PDF size:', fs.statSync(TEST_PDF_PATH).size, 'bytes');

    const formData = new FormData();
    formData.append('resume', fs.createReadStream(TEST_PDF_PATH), {
      filename: 'test-resume.pdf',
      contentType: 'application/pdf'
    });
    formData.append('userId', userId);
    formData.append('plan', 'basic');
    formData.append('jobInterest', 'Software Developer');
    formData.append('description', 'Test upload');

    console.log('Form data created with fields:', {
      userId,
      plan: 'basic',
      jobInterest: 'Software Developer',
      description: 'Test upload'
    });

    // Log request configuration
    console.log('Making upload request with config:', {
      url: `${API_URL}/api/resumes`,
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${token}`
      }
    });

    const uploadResponse = await axios.post(
      `${API_URL}/api/resumes`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${token}`
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

    console.log('Upload response:', uploadResponse.data);
    resumeId = uploadResponse.data.resumeId;
    return true;
  } catch (error) {
    console.error('Upload failed with error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      headers: error.response?.headers
    });
    return false;
  }
}

// Test payment intent creation
async function testPaymentIntent() {
  console.log('\n=== Testing Payment Intent Creation ===');
  try {
    const paymentResponse = await axios.post(
      `${API_URL}/api/payment/create-payment-intent`,
      {
        plan: 'basic',
        resumeId: resumeId
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Payment intent request details:', {
      url: `${API_URL}/api/payment/create-payment-intent`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: {
        plan: 'basic',
        resumeId: resumeId
      }
    });
    console.log('Payment intent response:', paymentResponse.data);
    if (paymentResponse.data.clientSecret) {
      console.log('Payment intent created successfully');
      return true;
    } else {
      console.log('Payment intent response missing client secret');
      return false;
    }
  } catch (error) {
    console.error('Payment intent creation failed:', {
      error: error.message,
      response: error.response?.data,
      status: error.response?.status,
      headers: error.response?.headers
    });
    return false;
  }
}

// Test resume download
async function testResumeDownload() {
  console.log('\n=== Testing Resume Download ===');
  try {
    const response = await axios.get(
      `${API_URL}/api/resumes/download-original/${resumeId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        responseType: 'stream'
      }
    );

    const downloadPath = path.join(__dirname, 'downloaded-test.pdf');
    const writer = fs.createWriteStream(downloadPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log('Resume downloaded successfully to:', downloadPath);
        resolve(true);
      });
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Download failed:', error.response?.data || error.message);
    return false;
  }
}

// Run all tests
async function runTests() {
  try {
    // Create test PDF
    createTestPDF();

    // Run tests in sequence
    const tests = [
      { name: 'Registration', fn: testRegistration },
      { name: 'Login', fn: testLogin },
      { name: 'Resume Upload', fn: testResumeUpload },
      { name: 'Payment Intent', fn: testPaymentIntent },
      { name: 'Resume Download', fn: testResumeDownload }
    ];

    let allPassed = true;
    const results = [];

    for (const test of tests) {
      console.log(`\nRunning ${test.name} test...`);
      const success = await test.fn();
      results.push({ name: test.name, success });
      if (!success) allPassed = false;
    }

    // Print summary
    console.log('\n=== Test Summary ===');
    results.forEach(result => {
      console.log(`${result.name}: ${result.success ? '✅ PASSED' : '❌ FAILED'}`);
    });

    return allPassed;
  } catch (error) {
    console.error('Test suite error:', error);
    return false;
  }
}

// Run the test suite
console.log('Starting integration tests...');
runTests()
  .then(success => {
    console.log('\nTest suite completed:', success ? 'PASSED' : 'FAILED');
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
  }); 