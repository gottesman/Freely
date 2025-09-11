// Test YouTube-DL integration
async function testYoutubeDl() {
  console.log('Testing YouTube-DL integration...');

  try {
    const YtDlpManager = require('./managers/YtDlpManager');

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 2000));

    const capabilityInfo = YtDlpManager.getCapabilityInfo();
    console.log('YouTube-DL capability info:', capabilityInfo);

    if (!capabilityInfo.loaded) {
      console.log('❌ YouTube-DL not available');
      return;
    }

    // Test getting video info for a known video
    console.log('Testing video info retrieval...');
    const videoId = 'dQw4w9WgXcQ'; // Rick Astley - Never Gonna Give You Up
    const info = await YtDlpManager.getInstance().getVideoInfo(videoId, '140');

    console.log('✅ Video info retrieved successfully:');
    console.log('- Video ID:', info.id);
    console.log('- Direct URL:', info.directUrl ? 'Available' : 'Not available');
    console.log('- Format:', info.format);

    // Test format picking
    const format = YtDlpManager.getInstance().pickAudioFormat(info);
    console.log('✅ Audio format selected:');
    console.log('- URL:', format.url ? 'Available' : 'Not available');
    console.log('- Codec:', format.acodec);
    console.log('- Extension:', format.ext);

  } catch (error) {
    console.error('❌ YouTube-DL test failed:', error.message);
  }
}


// YouTube search API test (existing)
function searchtest() {
  fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    "headers": {
      "accept": "*/*",
      "accept-language": "en;q=0.8",
      "cache-control": "no-cache",
      "content-type": "application/json",
      "pragma": "no-cache",
      "priority": "u=1, i",
      "sec-ch-ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
      "sec-ch-ua-arch": "\"x86\"",
      "sec-ch-ua-bitness": "\"64\"",
      "sec-ch-ua-full-version-list": "\"Chromium\";v=\"140.0.0.0\", \"Not=A?Brand\";v=\"24.0.0.0\", \"Google Chrome\";v=\"140.0.0.0\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-model": "\"\"",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-ch-ua-platform-version": "\"10.0.0\"",
      "sec-ch-ua-wow64": "?0",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "same-origin",
      "sec-fetch-site": "same-origin",
      "sec-gpc": "1",
      "x-goog-authuser": "0",
      "x-goog-visitor-id": "",
      "x-origin": "https://www.youtube.com",
      "x-youtube-bootstrap-logged-in": "true",
      "x-youtube-client-name": "0",
      "x-youtube-client-version": "2.20250904.01.00"
    },
    "referrer": "https://www.youtube.com/results",
    "body": "{\"context\":{\"client\":{\"hl\":\"en\",\"gl\":\"SV\",\"remoteHost\":\"\",\"deviceMake\":\"\",\"deviceModel\":\"\",\"visitorData\":\"\",\"userAgent\":\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36,gzip(gfe)\",\"clientName\":\"WEB\",\"clientVersion\":\"2.20250904.01.00\",\"osName\":\"Windows\",\"osVersion\":\"10.0\",\"originalUrl\":\"\",\"platform\":\"DESKTOP\",\"clientFormFactor\":\"UNKNOWN_FORM_FACTOR\",\"configInfo\":{\"appInstallData\":\"\",\"coldConfigData\":\"\",\"coldHashData\":\"\",\"hotHashData\":\"\"},\"userInterfaceTheme\":\"USER_INTERFACE_THEME_DARK\",\"browserName\":\"Chrome\",\"browserVersion\":\"140.0.0.0\",\"acceptHeader\":\"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8\",\"deviceExperimentId\":\"\",\"rolloutToken\":\"\",\"screenWidthPoints\":2560,\"screenHeightPoints\":1329,\"screenPixelDensity\":1,\"screenDensityFloat\":1,\"utcOffsetMinutes\":-360,\"memoryTotalKbytes\":\"4000000\",\"mainAppWebInfo\":{\"graftUrl\":\"/results\",\"pwaInstallabilityStatus\":\"PWA_INSTALLABILITY_STATUS_CAN_BE_INSTALLED\",\"webDisplayMode\":\"WEB_DISPLAY_MODE_BROWSER\",\"isWebNativeShareAvailable\":true}},\"user\":{\"lockedSafetyMode\":false},\"request\":{\"useSsl\":true,\"internalExperimentFlags\":[],\"consistencyTokenJars\":[]},\"clickTracking\":{\"clickTrackingParams\":\"\"},\"adSignalsInfo\":{\"params\":[]}},\"query\":\"never gonna give you up\",\"webSearchboxStatsUrl\":\"\"}",
    "method": "POST",
    "mode": "cors"
  }).then(async r => { console.log(await r.text()) })
}

function watchendpoint() {
  fetch('https://rr3---sn-uxab05-n5a6.googlevideo.com/initplayback?source=youtube&oeis=1&c=WEB&oad=3200&ovd=3200&oaad=11000&oavd=11000&ocs=700&oewis=1&oputc=1&ofpcc=1&msp=1&odepv=1&id=750c38c3d5a05dc4&ip=201.247.243.231&initcwndbps=1302500&mt=1757574325&oweuc=&v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&params=OAHAAQGqAxduZXZlciBnb25uYSBnaXZlIHlvdSB1cLoDCQjTyrLUmJecH7oDDxINUkRkUXc0dzlXZ1hjUboDCwis79vzqPHUiNwBugMKCI6mr8O1gpK2XLoDCgjp-_u4pam4y0K6AwsIt6CIiaiQ9rbGAboDCgix6Jah3v2zziu6AwoItsinl_ThyLkYugMKCLD5nMfwm_6zZroDCgiDkM-6wunGrQm6AwoI_e-Ait2qr_wDugMLCNPOgsukj6LgngG6AwoIweifxe6wvekaugMKCK3O5MehvpPgTLoDCgjuzorQosLA7CG6AwsIhaK1yISMpb6rAboDCgiB2sWu0JGv4A66AwsIpcqe2Yy3397MAboDCwiCsbqF16OKm6cB8gMFDXywCT24BQE%253D&pp=ygUXbmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXCgBwE%3D',
    {
      "headers": {
        "accept": "*/*",
        "accept-language": "en;q=0.8",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "priority": "u=1, i",
        "sec-ch-ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
        "sec-ch-ua-arch": "\"x86\"",
        "sec-ch-ua-bitness": "\"64\"",
        "sec-ch-ua-full-version-list": "\"Chromium\";v=\"140.0.0.0\", \"Not=A?Brand\";v=\"24.0.0.0\", \"Google Chrome\";v=\"140.0.0.0\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-model": "\"\"",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-ch-ua-platform-version": "\"10.0.0\"",
        "sec-ch-ua-wow64": "?0",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "same-origin",
        "sec-fetch-site": "same-origin",
        "sec-gpc": "1",
        "x-goog-authuser": "0",
        "x-goog-visitor-id": "",
        "x-origin": "https://www.youtube.com",
        "x-youtube-bootstrap-logged-in": "false",
        "x-youtube-client-name": "0",
        "x-youtube-client-version": "2.20250904.01.00"
      },
      "referrer": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "method": "GET",
      "mode": "no-cors",
      cookie: 'VISITOR_INFO1_LIVE=5RAjT9Frtrs; VISITOR_PRIVACY_METADATA=CgJTVhIEGgAgWw%3D%3D; HSID=AUi8tI8o32j3PJO5N; SSID=Av-MTd6KoGqG-kOv6; APISID=xE3acffHe_VljpqN/AYeN98cWQYKotc0YA; SAPISID=aT90hLzNMrDfwGbL/A8LtVOEDtoCr9_Iil; __Secure-1PAPISID=aT90hLzNMrDfwGbL/A8LtVOEDtoCr9_Iil; SID=g.a0000Qi3fDVSLc81cPsobzM0Nkd2k9cdfcpMRaMRbD8gj3I8W5oVNQa0C-syUhoetxUllg9IMAACgYKAS4SARcSFQHGX2Mimhwtj8O9FhG3fC6Dgv2osRoVAUF8yKpKF9EwTGLLIB0PXnG6HAJR0076; __Secure-1PSID=g.a0000Qi3fDVSLc81cPsobzM0Nkd2k9cdfcpMRaMRbD8gj3I8W5oVZltOzCDJ_Q4YR12FdoCrNQACgYKAbQSARcSFQHGX2MiVhuSoHuJx2wyECJKeH1AARoVAUF8yKpbY14DMJaXzuCE61xhxVAk0076; PREF=f6=40000000&f7=100&hl=en&tz=America.El_Salvador&f3=8&f5=30000; YSC=5nlQbCV0_aY; wide=1; __Secure-ROLLOUT_TOKEN=CN3ytcKHts-0ywEQuqTh99PuigMYldeHi4jQjwM%3D; __Secure-3PAPISID=G7SW4LoaFnKAJmEI/AgPElkqtwXVxmzVm9; __Secure-3PSID=g.a0000gi3fOrrrPac6s7aL-H4nFkd3KrO4elbjEnBrai9-FGxzOL3gmBipPX2JV9LIo5rXMu61AACgYKAeYSARcSFQHGX2MiCOGJQTpwqrpYyLDiGujqohoVAUF8yKoBgyHW9s5fZYi3_6YuPeIR0076; LOGIN_INFO=AFmmF2swRQIgZdqb4C-oEqZW__nc-gE82hJ7THckkyG2P0NULvKPS9MCIQCpcvqe-Svm8XT2f9oxKJtEpKf0w-Qqmi8eDzBiVLuW6Q:QUQ3MjNmekZ2SW5nb2g5SUFpb3loVXdaWWJQemhVQ0l5MGdtMmNDak1XdXRGYllCblRNdDF5Q0xWeC02OGRzS0FjS1I1REZaM0daampaR3BfNEh2ellGbUlJaGMtSWVLaS1ZcExrUlZOZzNFdW5hZzlwY2JILXAzdUxNRjJFMGFPSDZBZFoteUg1MlVObTFSd1ZJMHZzOTh3VVppVUZVdWhB; __Secure-1PSIDTS=sidts-CjQB5H03P5oGfeN-yOq643dZp2n7N-AKNq0S4h4sKYCX89YCuW89Xfit0a5DzJW7vRg_eCryEAA; __Secure-3PSIDTS=sidts-CjQB5H03P5oGfeN-yOq643dZp2n7N-AKNq0S4h4sKYCX89YCuW89Xfit0a5DzJW7vRg_eCryEAA; SIDCC=AKEyXzWch4sfgDQWiJ14r3ButE8HS2oLKoSipbmJo-5BokKS8j8MGGTS-n7nfV-a_kUHoRKneD4; __Secure-1PSIDCC=AKEyXzWs6TwRxSnDeN-rGZrsTpo9L-2jWgksjw23zkQON8skvpXWpTn1G7o0CtjxIR-dg7Xu6Ac; __Secure-3PSIDCC=AKEyXzV0lZmXhATZJlYb31RLCgF4hAbJ1ej8gM2pOCiNA1ELcdwE-D3UBH2VwWAoW47w2byZDk4; ST-xuwub9=session_logininfo=AFmmF2swRgIhAI8KnQqgiNaI4sbwKhwowNXBodS0jaq0KbovDvlSgrlHAiEA2sMj7dGqnwRBW-p2oA8EbMh_seKUE6eg2dKlgAm0kdw%3AQUQ3MjNmeWFLQ2lJY3VQb09BN0Jna19jTFBIczRHMXV5eG0yd0NOOEJERjdiSk5HTDZjMzg2WmVEcGo4dHRkLUQ1cm5Ic3IwNHJRbFdFMlpMM1I4Y0l6TlZkU2ZVWkRTRjNJRG90NU4yUlUtQ1VEdjg4VUU0MkNDQ3IyNkRleG9LSy1DYmNVUFdvZ2NpTC1lbVNXeW0xYktnSTJyWFdwSXpR'
    })
}

// Run YouTube-DL test
//testYoutubeDl();