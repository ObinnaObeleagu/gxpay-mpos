// 蓝牙设备提供的服务的 UUIDs

// var MPOS_SERVICE = "0000180a-0000-1000-8000-00805f9b34fb";
// var MPOS_VALUE = "00002a29-0000-1000-8000-00805f9b34fb";
var MPOS_SERVICE = "49535343-fe7d-4ae5-8fa9-9fafd205e455";
var MPOS_VALUE = "49535343-8841-43f4-a8d4-ecbe34729bb3";
var notify_uuid = "49535343-1e4d-4bd9-ba61-23c647249616";

var MPOS_DATA_Ready = false;
var MPOS_Notify_State;

//设备抽象
var Connected_Device;
//连接状态
var Connected_Server;
var Connected = false;
//服务是否存在
var MPOS_SERVICE_FLAG = false;

document.addEventListener('DOMContentLoaded', async () => {
    console.log('Startup ----');
    let devices = await navigator.usb.getDevices();
    devices.forEach(device => {
      // prettier-ignore
      console.log(`USB Device Detected: ${device.productName}     serial: ${device.serialNumber}     vendorId: ${device.vendorId}`);
    });
  });
  
navigator.usb.addEventListener('connect', event => {
    console.warn('A USB Device was connected');
});
  
navigator.usb.addEventListener('disconnect', event => {
    console.warn('A USB Device was disconnected!');
});
  
let button = document.getElementById('request-device');
let contiUpdateEmvBtn = document.getElementById('continue-updateEmv');

var trasactionData = document.getElementById("result_div");
var infoData = document.getElementById("div_infoResult");
var updateResult = document.getElementById("div_updateResult");

var mService = new QPOSService();
function QPOSServiceListenerImpl() {}
var qPOSServiceListenerImpl = new QPOSServiceListenerImpl();
mService.initListener(qPOSServiceListenerImpl);
mOnResult = new QPOSAnalyResult(qPOSServiceListenerImpl);

QPOSServiceListenerImpl.prototype.onQposInfoResult = function (deviceInfo) {
    console.log("onQposInfoResult:" + deviceInfo);
    var str = "";
    for(var key in deviceInfo){
        str += key + ": " +deviceInfo[key]+"\r";
    }
    infoData.innerText = "onQposInfoResult:" + "\r" + str;
}
QPOSServiceListenerImpl.prototype.onQposIdResult = function (deviceId) {
    console.log("onQposIdResult" + deviceId);
    var str = "";
    for(var key in deviceId){
        str += key + ": " +deviceId[key]+"\r";
    }
    infoData.innerText = "onQposIdResult:" + "\r" + str;
}
QPOSServiceListenerImpl.prototype.onRequestSelectEmvApp = function (hashtable) {
    console.log("onRequestSelectEmvApp:" + hashtable);
    mService.selectEmvApp(0);
}

QPOSServiceListenerImpl.prototype.onRequestDisplay = function (msg) {
    console.log("onRequestDisplay: " + msg);
    handleDeviceDisplay(msg);
}
// The Dspread SDK core (main.js) has a typo at one call site - it invokes
// "onReqestDisplay" (missing the first "u") instead of "onRequestDisplay"
// when a chip card is DECLINED OFFLINE (the card's own risk management
// rejects the transaction without ever going online - a normal, everyday
// EMV outcome, not an edge case). Because that misspelled method didn't
// exist, calling it threw an uncaught TypeError inside the SDK's internal
// processing chain, which aborted the very next two calls in that same
// statement - onRequestBatchData(...) and, critically,
// onRequestTransactionResult(TransactionResult.DECLINED) - before they
// could run. The end result: the UI never heard about the decline at all
// and stayed stuck on "Waiting for card..." forever. This implements the
// misspelled method (matching the SDK's actual call) so that chain
// completes normally instead of throwing.
QPOSServiceListenerImpl.prototype.onReqestDisplay = function (msg) {
    console.log("onReqestDisplay: " + msg);
    handleDeviceDisplay(msg);
}
function handleDeviceDisplay(msg) {
    if (msg === "REMOVE_CARD" && window.PaymentProcessor) {
        PaymentProcessor.onDeviceMessage('Please remove the card.');
    }
}

QPOSServiceListenerImpl.prototype.onRequestWaitingUser = function (msg) {
    console.log("onRequestWaitingUser" + msg);
    if (window.PaymentProcessor) {
        PaymentProcessor.onWaitingForCard();
    } else {
        trasactionData.innerText = "Please insert/swipe/tap card now.";
    }
}

// Fires with the device's own outcome for the transaction (APPROVED,
// DECLINED, TERMINATED, CANCEL, CAPK_FAIL, NOT_ICC, SELECT_APP_FAIL,
// DEVICE_ERROR, CARD_NOT_SUPPORTED, ...). For an ONLINE-authorized
// transaction this fires alongside (and is secondary to) the GxPay result
// already shown via PaymentProcessor's receipt panel. But for a card that's
// declined OFFLINE - never contacting GxPay at all - this is the ONLY
// signal the app ever receives, so it has to be surfaced here or the
// operator sees nothing.
QPOSServiceListenerImpl.prototype.onRequestTransactionResult = function (msg) {
    console.log("onRequestTransactionResult: " + msg);
    if (!window.PaymentProcessor) return;
    if (msg === "APPROVED") {
        // The online-authorized path already shows GxPay's own result via
        // onOnlineAuthorizationRequest/onTradeComplete - nothing extra needed.
        return;
    }
    PaymentProcessor.onDeviceError(
        'declined',
        msg === "DECLINED" ? 'Card declined (offline - not sent to GxPay).' : `Transaction ended: ${msg}`
    );
}
QPOSServiceListenerImpl.prototype.onError = function (msg) {
    console.log("onError: " + msg);
    if (window.PaymentProcessor) {
        PaymentProcessor.onDeviceError('error', "Device error: " + msg);
    } else {
        trasactionData.innerText = "onError:" + msg;
    }
}
QPOSServiceListenerImpl.prototype.onEmvICCExceptionData = function (msg) {
    console.log("onEmvICCExceptionData" + msg);
    trasactionData.innerText = "onEmvICCExceptionData:" + msg;
}
QPOSServiceListenerImpl.prototype.onLcdShowCustomDisplay = function(msg){
    console.log("onLcdShowCustomDisplay" + msg);
}

QPOSServiceListenerImpl.prototype.onReturnDoInputCustomStr = function(msg,name){
    console.log("onReturnDoInputCustomStr: " + msg);
    console.log(name);
}

QPOSServiceListenerImpl.prototype.onDoTradeResult = function (msg,msg1) {
    // NOTE: this handler used to write raw track1/track2/PAN/expiry/pinBlock
    // straight into the page - that's cardholder data and never belongs in
    // the DOM or in application logs. It's now routed through
    // PaymentProcessor, which only ever displays a masked PAN and forwards
    // the already-encrypted (DUKPT/3DES) material to our own backend over
    // HTTPS. See public/dist/js/paymentProcessor.js.
    console.log("onDoTradeResult: " + msg);
    if (msg=="ICC") {
        // Chip transactions are authorized earlier, in
        // onRequestOnlineProcess (the real "call GxPay" moment for EMV) -
        // by the time we get here the card has already finished its
        // cryptogram exchange, so just let PaymentProcessor render whatever
        // result it already has.
        if (window.PaymentProcessor) {
            PaymentProcessor.onTradeComplete('ICC');
        } else {
            trasactionData.innerText = "onDoTradeResult: " + msg;
        }
    }else if(msg=="MCR"){
        if (window.PaymentProcessor) {
            PaymentProcessor.onCardRead('MCR', msg1);
        } else {
            trasactionData.innerText = "onDoTradeResult: " + msg;
        }
    }else if (msg=="NFC_ONLINE") {
        if (window.PaymentProcessor) {
            PaymentProcessor.onCardRead('NFC_ONLINE', msg1);
        } else {
            trasactionData.innerText = "onDoTradeResult: " + msg;
        }

        mService.getNFCBatchData(function onSuccess(nfcBatchData) {
            // Batch data is EMV-derived and can include sensitive tags -
            // don't print it. Kept for future use if GxPay's contactless
            // authorization needs it alongside the track/KSN data already
            // sent in onCardRead().
            console.log("NFCBatchData received (" + nfcBatchData.length + " chars), not displayed.");
        } , function onError(error){
            console.log(error);
        });
        
    }else if (msg=="NFC_OFFLINE" || msg=="NFC_DECLINED") {
        if (window.PaymentProcessor) {
            PaymentProcessor.onDeviceError('declined', "Card declined by card (" + msg + ").");
        } else {
            trasactionData.innerText = "onDoTradeResult: " + msg;
        }
    }else if (msg=="TRY_ANOTHER_INTERFACE" || msg=="BAD_SWIPE" || msg=="NONE" || msg=="NOT_ICC" || msg=="NO_RESPONSE" || msg=="NO_UPDATE_WORK_KEY") {
        if (window.PaymentProcessor) {
            PaymentProcessor.onDeviceError('error', "Card read failed (" + msg + "). Please try again.");
        } else {
            trasactionData.innerText = "onDoTradeResult: " + msg;
        }
    }
  
}

QPOSServiceListenerImpl.prototype.onRequestOnlineProcess = function (msg) {
    // This is the real authorization point for chip (EMV) transactions: the
    // device has produced its online-authorization request (ARQC + TLV
    // tags) and is waiting for an authorization response before it can
    // complete the transaction. The original demo hardcoded "8A023030"
    // (always-approved) here and never contacted a payment processor -
    // that's now replaced with an actual GxPay authorization call.
    console.log('onRequestOnlineProcess ='+msg);
    if (window.PaymentProcessor) {
        PaymentProcessor.onOnlineAuthorizationRequest(msg, function (resultTlv) {
            mService.sendOnlineProcessResult(resultTlv);
        });
    } else {
        // Fail safe if paymentProcessor.js didn't load for some reason -
        // decline rather than silently auto-approving.
        console.error('PaymentProcessor not loaded - declining chip transaction.');
        mService.sendOnlineProcessResult("8A023035");
    }
}

QPOSServiceListenerImpl.prototype.onRequestBatchData = function (iccData) {
    // iccData is EMV TLV batch data (can include track-equivalent tags) -
    // logged for debugging only, never shown in the UI.
    console.log("onRequestBatchData received (" + (iccData ? iccData.length : 0) + " chars)");
    mService.getNewICCTag(0,1,'57',function onSuccess(iccResult) {
            console.log("getNewICCTag(57) received");
        } , function onFail(error){
            console.log(error);
        });
    
} 

QPOSServiceListenerImpl.prototype.onReturnReversalData = function (iccData) {
    console.log("onReturnReversalData" + iccData);
    updateResult.innerText = "onReturnReversalData:" +"\r"+ iccData;
}

QPOSServiceListenerImpl.prototype.onReturnGetEMVListResult = function (aidString) {
    console.log("onReturnGetEMVListResult(aidString)" + aidString);
    updateResult.innerText = "onReturnGetEMVListResult: " + aidString;
}
QPOSServiceListenerImpl.prototype.onReturnUpdateEMVResult = function (flag) {
    console.log("onReturnUpdateEMVResult: " + flag);
    if (flag) {
        updateResult.innerText = "onReturnUpdateEMVResult: Success"; 
    }else{
        updateResult.innerText = "onReturnUpdateEMVResult: Fail";
    }
}
QPOSServiceListenerImpl.prototype.onReturnUpdateEMVRIDResult = function (flag) {
    console.log("onReturnUpdateEMVRIDResult: " + flag);
    if (flag) {
        updateResult.innerText = "onReturnUpdateEMVRIDResult: Success"; 
    }else{
        updateResult.innerText = "onReturnUpdateEMVRIDResult: Fail";
    }
    contiUpdateEmvBtn.style.display = "none";
}
QPOSServiceListenerImpl.prototype.onReturnCustomConfigResult = function (flag, msg) {
    console.log("onReturnCustomConfigResult: " + flag+ " "+msg);
    if (flag) {
        updateResult.innerText = "onReturnCustomConfigResult: Success\n"+msg; 
    }else{
        updateResult.innerText = "onReturnCustomConfigResult: Fail\n"+msg;
    } 
    contiUpdateEmvBtn.style.display = "none";
}
QPOSServiceListenerImpl.prototype.onReturnSetMasterKeyResult = function (flag) {
    console.log("onReturnSetMasterKeyResult: " + flag);
    if (flag) {
       trasactionData.innerText = "onReturnSetMasterKeyResult: Success"; 
    }else{
       trasactionData.innerText = "onReturnSetMasterKeyResult: Fail";
    } 
}
QPOSServiceListenerImpl.prototype.onRequestUpdateWorkKeyResult = function (flag) {
    console.log("onRequestUpdateWorkKeyResult: " + flag);
    if (flag) {
        updateResult.innerText = "onRequestUpdateWorkKeyResult: Success"; 
    }else{
        updateResult.innerText = "onRequestUpdateWorkKeyResult: Fail";
    } 
}
QPOSServiceListenerImpl.prototype.onSearchMifareCardResult = function (value) {
    console.log("onSearchMifareCardResult: " + value);
    
    var status = value.status;
    var cardType = value.cardType;
    var ATQA = value.ATQA;
    var SAK = value.SAK;
    var cardUidLen = value.cardUidLen;
    var cardUid = value.cardUid;
    var cardAtsLen = value.cardAtsLen;
    var cardAts = value.cardAts;
    console.log(status+" "+cardType+" "+ATQA+" "+SAK+" "+cardUid+" "+cardAts);  
}

QPOSServiceListenerImpl.prototype.onFinishMifareCardResult = function (flag) {
    console.log("onFinishMifareCardResult: " + flag);
}

QPOSServiceListenerImpl.prototype.onReturnGetPinResult = function (value) {
    console.log("onReturnGetPinResult: " + value);
}

QPOSServiceListenerImpl.prototype.onRequestSetPin = function () {
    console.log("onRequestSetPin: ");
    // mService.sendPin("1234");
    dialog();
}

QPOSServiceListenerImpl.prototype.onReturnUpdateIPEKResult = function (flag) {
    console.log("onReturnUpdateIPEKResult: " + flag);
    if (flag) {
       trasactionData.innerText = "onReturnUpdateIPEKResult: Success"; 
    }else{
       trasactionData.innerText = "onReturnUpdateIPEKResult: Fail";
    } 
}

QPOSServiceListenerImpl.prototype.onReturnApduResult = function(result,apdu,apduLen){
    console.log("onReturnApduResult(boolean result,String apdu,int adpuLen)----------" + result+"\n"+apdu+"\n"+apduLen);
    trasactionData.innerText = "onReturnApduResult:"+result+"\n"+"apdu is "+apdu+"\n"+"length is "+apduLen;
}

QPOSServiceListenerImpl.prototype.onReturnPowerOffNFCResult = function(result){
    console.log("onReturnPwerOffNFCResult:"+result);
    if(result){
        trasactionData.innerText = "onReturnPwerOffNFCResult:success";
        mService.doSetBuzzerOperation(2);
    }else{
        trasactionData.innerText = "onReturnPwerOffNFCResult:fail";
    }
}

QPOSServiceListenerImpl.prototype.onReturnPowerOnNFCResult = function(result,ksn,atr,atrLen){
    console.log("onReturnPowerOnNFCResult(boolean result,String ksn,String atr,int atrLen)-------"+result+"\n"+ksn+"\n"+atr+"\n"+atrLen);
    trasactionData.innerText = "onReturnPowerOnNFCResult:"+result+"\n"+"ksn:"+ksn+"\n"+"atr:"+atr+"\n"+"atrLen:"+atrLen;
}

QPOSServiceListenerImpl.prototype.onSetBuzzerResult = function(result){
    console.log("onSetBuzzerResult(result)-------"+result);
}


QPOSServiceListenerImpl.prototype.onUpdatePosFirmwareResult = function(result,str){
    console.log("onUpdatePosFirmwareResult:"+result+"\n"+str);
    updateResult.innerText = "onUpdatePosFirmwareResult:"+result+"\n"+str;
}

QPOSServiceListenerImpl.prototype.onRturnSwitchWinusbResult = function (isSuccess) {
    console.log("onRturnSwitchWinusbResult" + isSuccess);
    trasactionData.innerText ="Switch to Serial is "+isSuccess;
}

QPOSServiceListenerImpl.prototype.onReturnShowEMVOfXml = function(list){
    updateResult.innerHTML = "";
    for(x in list){
        // console.log(list[x]);
        if(list[x].type == "APP")
            updateResult.innerHTML =updateResult.innerHTML+"type:"+list[x].type+" Aid:"+list[x].id+" index:"+list[x].index+"</br>";
        else
            updateResult.innerHTML =updateResult.innerHTML+"type:"+list[x].type+" Rid:"+list[x].id+" index:"+list[x].index+"</br>";
    }
    contiUpdateEmvBtn.style.display = "block";
}

function getProgress(progress){
    if(progress == "100"){
        updateResult.innerHTML = "update successfully";
    } else{
        updateResult.innerHTML = "update process:"+parseInt(progress)+"%";
    }
}

button.addEventListener('click', async () => {
    if (button.innerHTML === 'USB Connect') {
      connectToDeviceUSB();
      mService.setCommunicationMode(CommunicationMode.USB); 
      Connected = true;
      
    } else {
      // disconnect the USB device
      // TODO: figure out how to release this
      // await mDevice.close(); 
      disconnectToDeviceUSB();
      button.innerHTML = 'USB Connect';
      Connected = false;
    }
  });

contiUpdateEmvBtn.addEventListener('click',async()=>{
    updateResult.innerHTML ="updating...</br>"+updateResult.innerHTML;
    mService.updateEMVConfigByXml(mEMVConfigBuffer);
    contiUpdateEmvBtn.style.display = "none";

});

function dialog(){
  var str = prompt("Please input your pin","123456");
  if(str){
    console.log("dialog = "+str);
    mService.sendPin(str);
  }
}

var mEMVConfigBuffer;
function upload(input) {  //支持chrome IE10  
    console.log("upload");

    if (window.FileReader) {  
        console.log("upload");
        var file = input.files[0];  
        filename = file.name.split(".")[0];  
        var reader = new FileReader();  
        reader.onload = function() {  
            // alert(this.result.length); 
            // mService.updateEMVConfigByXml(this.result);
            mEMVConfigBuffer = this.result;
            console.log("xml:\n"+mEMVConfigBuffer);
            mService.showEMVListOfXml(mEMVConfigBuffer);
        }  
        reader.readAsText(file);  
        document.getElementById('updateEmvFile').value = null;
    }
    else{
        alert("not support");
    }
}

function selectEmvFile(){
    //$('#updateEmvFile').click();
    // updateResult.innerHTML = "132456</br>123333";
    // console.log(contiUpdateEmvBtn.style.display);

    // if(contiUpdateEmvBtn.style.display=="none")
    //     contiUpdateEmvBtn.style.display = "inline-block";
    // else
    // contiUpdateEmvBtn.style.display = "none";

    if(Connected){
        //mService.resetPosStatus();
        // mService.doSetBuzzerOperation(3);
        updateResult.innerText = "updating EMV..."
        document.getElementById("updateEmvFile").click();
    } else{
        DiscoverDevice();
        UpdateUI();
    }
}

function switchToSerial(){
    if(Connected){
        mService.setCommunicationMode(CommunicationMode.USB);
        mService.testCommand("00");
    } else{
        DiscoverDevice();
        UpdateUI();
    }
}

function dialog(){
    var str = prompt("Please input your pin","123456");
    if(str){
      console.log("dialog = "+str);
      mService.sendPin(str);
    }
  }
  
  function upload2(input) {  //支持chrome IE10  
      console.log("upload2");
      if (window.FileReader) {  
          console.log("upload2");
          var file = input.files[0];  
          filename = file.name.split(".")[0];  
          var reader = new FileReader();  
          reader.onload = function() {  
            //   alert(testChar(this.result).length); 
              mService.updatePosFirmware(testChar(this.result),Connected_Device);
          }  
          reader.readAsArrayBuffer(file); 
          document.getElementById('updateFwFile').value = null;
      }
      else{
          alert("not support");
      }
  }
  
  function selectFwFile(){
      //$('#updateEmvFile').click();
      if(Connected){
          //mService.resetPosStatus();
          // mService.doSetBuzzerOperation(3);
          updateResult.innerText = "updating Firmware...";
        document.getElementById("updateFwFile").click();
      } else{
          DiscoverDevice();
          UpdateUI();
      }
  }

  function testChar(data){
    var hexString = byteArray2Hex(data);
    return hexString;
}

//连接设备或断开连接
function DiscoveOrDisConnect() {
    console.log("DiscoveOrDisConnect = "+Connected);
    if (Connected) {
        Connected_Device.gatt.disconnect();
        console.log("===>用户断开了连接<===")
        UpdateUI();
    }else {
        DiscoverDevice();
        UpdateUI();
    }
}

// Starts a card-present trade on the device. Called by PaymentProcessor.checkout()
// with explicit (amount, currencyNumeric, transactionType) once the operator
// clicks "Checkout / Pay"; falls back to reading the form fields directly if
// called with no args, for backward compatibility.
function startTrade(amount, currency, tractionType){
    if (amount === undefined) {
        currency = document.getElementById("currency_code").value;
        amount = document.getElementById("Amount").value;
        tractionType = document.getElementById("TractionType").value;
    }
    if(Connected){

        setAmount(amount, "", currency, transactionTypeConvert(tractionType));
        // mService.setIsSupportClsSelectEmvAPP(true);

        mService.doTrade(0,20);
        // setAmountIcon(AmountType.MONEY_TYPE_CUSTOM_STR,"Rs");
        // mService.getQPosInfo();
        // var strArr = stringToBytes("enter amount");
        // var displayStr = byteArray2Hex(strArr);
        // mService.lcdShowCustomDisplay(LcdModeAlign.LCD_MODE_ALIGNCENTER,displayStr,10);
        // mService.doInputCustomStr(CustomInputOperateType.isNumber, CustomInputDisplayType.Other, 6,displayStr,"test",amount);
        // mService.doUpdateIPEKOperation("0","09120200630001E0004C","2B7D562AFA3EAC7970664394CD19D3D3","B62AA00000000000",
        // 	"09120200630001E0004C","2B7D562AFA3EAC7970664394CD19D3D3","B62AA00000000000","09120200630001E0004C","2B7D562AFA3EAC7970664394CD19D3D3","B62AA00000000000")
    }else{
        DiscoverDevice();
        UpdateUI();
    }
}

function getQPosInfo(){
    mService.getQPosInfo();
}

function getQPosId(){
    mService.getQPosId();
}


function transactionTypeConvert(str){
   console.log("Str:" + str);
   if (str == "0") {
       return TransactionType.GOODS;
   }else if (str == "1") {
       return TransactionType.SERVICES;
   }else if (str == "2") {
       return TransactionType.CASH;
   }else if (str == "3") {
       return TransactionType.CASHBACK;
   }else if (str == "4") {
       return TransactionType.INQUIRY;
   }else if (str == "5") {
       return TransactionType.TRANSFER;
   }else if (str == "6") {
       return TransactionType.ADMIN;
   }else if (str == "7") {
       return TransactionType.CASHDEPOSIT;
   }else if (str == "8") {
       return TransactionType.PAYMENT;
   }else if (str == "9") {
       return TransactionType.PBOCLOG;
   }else if (str == "10") {
       return TransactionType.SALE;
   }else if (str == "11") {
       return TransactionType.PREAUTH;
   }else if (str == "12") {
       return TransactionType.ECQ_DESIGNATED_LOAD;
   }else if (str == "13") {
       return TransactionType.ECQ_UNDESIGNATED_LOAD;
   }else if (str == "14") {
       return TransactionType.ECQ_CASH_LOAD;
   }else if (str == "15") {
       return TransactionType.ECQ_CASH_LOAD_VOID;
   }else if (str == "16") {
       return TransactionType.UPDATE_PIN;
   }else if (str == "17") {
       return TransactionType.REFUND;
   }else if (str == "18") {
       return TransactionType.SALES_NEW;
   }else if (str == "19") {
       return TransactionType.LEGACY_MONEY_ADD;
   }else if (str == "20") {
       return TransactionType.NON_LEGACY_MONEY_ADD;
   }else if (str == "21"){
       return TransactionType.BALANCE_UPDATE;
   }
}

var appCfgStr = "";
var capkCfgStr = "";
function readLine(){
   appCfgStr="";
   capkCfgStr="";
   const ipt = document.createElement('input')
   ipt.type = 'file'
   ipt.style.display = 'none'
   document.body.appendChild(ipt)
   ipt.click()

   ipt.onchange = () => {
   const files = ipt.files[0]
   var fileName = files.name;
   const reader = new FileReader()
   reader.readAsArrayBuffer(files)
   reader.onload = () => {
        var content = byteArray2Hex(reader.result);
        if ("emv_app.bin" == fileName) {
            appCfgStr = content;
            console.log("app:"+"\r"+appCfgStr);
        }else if ("emv_capk.bin" == fileName) {
            capkCfgStr = content;
            console.log("\r"+"capk:"+"\r"+capkCfgStr);
        } 
    }
   }
}

//发现蓝牙设备
function DiscoverDevice() {
    //过滤出我们需要的蓝牙设备
    //过滤器
    var options = {
        filters: [{ namePrefix: 'MPOS' },{ namePrefix: 'QPOS' },{ namePrefix: 'VEL' },{ namePrefix: 'MIPS' },{ namePrefix: 'watu' },{ namePrefix: 'POINT' }],
        optionalServices: [MPOS_SERVICE]
    };

    navigator.bluetooth.requestDevice(options)
        .then(device => {
            console.log(device);
            console.log('> 设备名称: ' + device.name);
            console.log('> 设备Id: ' + device.id);
            console.log('> 是否已连接到其它设备: ' + device.gatt.connected);
            //连接到该设备
            Connected_Device = device;
            ConnectDevice();
        })
        .catch(error => {
            console.log("=> Exception: " + error);
        });
}

//连接到蓝牙设备
function ConnectDevice() {
    Connected_Device.gatt.connect().then(
        function (server) {
            console.log("> 连接到GATT服务器：" + server.device.id);
            console.log("> 连接成功=" + server.connected);
            //更新UI的信息
            Connected = true;
            UpdateUI();
            //将Server赋给全局变量（已连接的GATT服务器
            Connected_Server = server;

            //监听连接断开事件
            Connected_Device.addEventListener('gattserverdisconnected', function () {
                console.log('disconnect ')
                Connected = false;
                UpdateUI();
            });
            //发现GATT服务器的服务
            DiscoverService();
        },
        function (error) {
            console.log("=> Exception:无法连接 - " + error);
            Connected = false;
            UpdateUI();
        });
}

//发现蓝牙设备的服务和特性
function DiscoverService() {
    console.log("> 正在搜索可用的服务......\n> 服务器：" + Connected_Server);

    //已发现的服务
    let ServicesDiscovered = 0;

    Connected_Server.getPrimaryServices()
        .then(Services => {

            //服务总数
            let ServiceSum = Services.length;
            console.log("> 发现服务数量：" + ServiceSum);

            Services.forEach(service => {
                if (service.uuid == MPOS_SERVICE) {
                    MPOS_SERVICE_FLAG = true;
                    console.log("=> MPOS SERvice uuid: " + service.uuid);
                }

                console.log("> 获取到服务的UUID：" + service.uuid);

                service.getCharacteristics().then(Characteristics => {
                    console.log("> 服务: " + service.uuid);
                    ServicesDiscovered++;

                    //已发现的特性
                    let CharacteristicsDiscovered = 0;
                    //所有的特性
                    let CharacteristicsSum = Characteristics.length;

                    Characteristics.forEach(Characteristic => {

                        CharacteristicsDiscovered++;
                        console.log('>> 特征值(UUID): ' + Characteristic.uuid);
                        if(Characteristic.uuid == MPOS_VALUE){
                            writeChar = Characteristic;
                            MPOS_DATA_Ready = true;
                            mService.setCommunicationMode(CommunicationMode.BLUETOOTH);
                            new webBluetooth(mOnResult,writeChar);
                        }else if(Characteristic.uuid == notify_uuid){
                            MPOS_Notify_State = Characteristic;
                            registNotify(MPOS_Notify_State);
                        }
                        if (ServicesDiscovered == ServiceSum && CharacteristicsDiscovered == CharacteristicsSum) {
                            console.log("===>服务搜索完成<===");
                            //更新UI的信息
                            UpdateUI();
                            //读取设备型号
                            ReadModelStr();
                        }
                    });

                });
            });
        });
}

//读取设备型号字符串
function ReadModelStr() {
    writeChar.readValue()
        .then(value => {
            data = new Uint8Array(value.buffer);
            console.log("=> DEVICE DATA: " + data);
            let Str = new TextDecoder("utf-8").decode(data);
            //document.getElementById("UI_DeviceType").innerHTML = "Connect Type：" + Str;
        })
        .catch(error => {
            console.log("=> 出现错误: " + error);
            return;
        });
}

//更新UI
function UpdateUI() {
    //是否已连接
    console.log("UpdateUI = "+Connected);
    var connEl = document.getElementById("UI_Connected");
    if (Connected) {
        connEl.innerHTML = "Connected:"+Connected_Device.name;
        connEl.classList.add("is-connected");
    }
    else {
        connEl.innerHTML = "Connect";
        connEl.classList.remove("is-connected");
        MPOS_DATA_Ready = false;
    }

    //设备类型是否就绪
    if (MPOS_DATA_Ready) {
        console.log("Can do start now");
    }
    else {
        console.log("Please check your device now");
    }
}

//设置要显示的字符串
function SetString(){
    let str=document.getElementById("input_str").value;
    let arr= new Array();

    for (let i = 0; i < str.length; i++) {
        arr.push(str.charCodeAt(i));
    }
    arr.push(10);

    let Buff=new Uint8Array(arr);
    UART_State.writeValue(Buff.buffer);
}

function powerOnNFC(){
    if(Connected){
        mService.powerOnNFC(30);
    } else{
        DiscoverDevice();
        UpdateUI();
    }
}

function sendApduByNFC(){
    if(Connected){
        mService.sendApduByNFC("1234",5);
    } else{
        DiscoverDevice();
        UpdateUI();
    }
}

function powerOffNFC(){
    if(Connected){
        mService.powerOffNFC(20);
    } else{
        DiscoverDevice();
        UpdateUI();
    }
}
//InitUI();
UpdateUI();