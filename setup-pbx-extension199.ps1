param(
  [string]$Server = "10.1.0.223",
  [string]$ServerAlias = "pbx.nbr.ru",
  [int]$Port = 5060,
  [ValidateSet("udp", "tcp")]
  [string]$Transport = "udp",
  [string]$Username = "199",
  [int]$SignalingPort = 5060,
  [int]$RtpPortMin = 40200,
  [int]$RtpPortMax = 40398,
  [int]$SidecarHttpPort = 3899,
  [string]$TnvedApiBase = "http://127.0.0.1:8099",
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\pbx199.local.json",
  [string]$SecretPath = "$env:USERPROFILE\.agenticmail\pbx199.secret.dpapi",
  [switch]$EnableLiveAnswer,
  [switch]$EnableOutboundCalls,
  [switch]$NoSecret
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-service-common.ps1")

function Write-Utf8NoBom($Path, $Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Protect-LocalSecret($Path, [securestring]$Secret) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    Write-AgenticMailMachineSecretFile -Path $Path -Secret $plain
  } finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
}

$secretStored = Test-Path -LiteralPath $SecretPath
if (-not $NoSecret) {
  $secure = Read-Host -Prompt "PBX password for SIP extension $Username" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Length -eq 0) {
      throw "PBX password cannot be empty."
    }
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  Protect-LocalSecret -Path $SecretPath -Secret $secure
  $secretStored = $true
}

$payload = [ordered]@{
  profile = "sales-pbx-extension-199"
  provider = "nbr_internal_pbx"
  type = "sip_extension"
  server = $Server
  serverAlias = $ServerAlias
  port = $Port
  transport = $Transport
  username = $Username
  signalingPort = $SignalingPort
  rtpPortMin = $RtpPortMin
  rtpPortMax = $RtpPortMax
  sidecarHttpPort = $SidecarHttpPort
  tnvedApiBase = $TnvedApiBase.TrimEnd("/")
  tnvedConsultationEnabled = $true
  secretRef = $SecretPath
  secretFormat = "windows_dpapi_local_machine_v1"
  secretStored = [bool]$secretStored
  liveAnswerEnabled = [bool]$EnableLiveAnswer
  liveOutboundEnabled = [bool]$EnableOutboundCalls
  agenticmailDirectSipSupported = $false
  sipSidecarSupported = $true
  sipSidecarScript = (Join-Path $PSScriptRoot "sip-sidecar\sip-sidecar.mjs")
  postGreetingSilencePromptDelayMs = 2000
  managerExtensions = [ordered]@{
    sales = "135"
  }
  managerRouteAliases = [ordered]@{
    sales = "customer_service"
    operator = "customer_service"
    general = "customer_service"
  }
  managerRoutes = [ordered]@{
    customer_service = [ordered]@{
      label = "Отдел по работе с клиентами"
      selection = "round_robin"
      topics = @(
        "общие вопросы"
        "вопросы без конкретизации"
        "первичное обращение, когда профиль не определён"
      )
      destinations = @(
        [ordered]@{ extension = "135"; employee = "Irina A."; aliases = @("Ирина", "Ирина А", "Irina A") }
        [ordered]@{ extension = "136"; employee = "Marina S."; aliases = @("Марина", "Марина С", "Marina S") }
      )
    }
    payment_agent = [ordered]@{
      label = "Оплаты через платёжного агента"
      selection = "primary"
      topics = @(
        "оплата поставщикам"
        "оплата автомобилей и других товаров"
        "оплата в другие страны"
        "услуги платёжного агента"
      )
      destinations = @(
        [ordered]@{ extension = "141"; employee = "Anton M."; aliases = @("Антон", "Антон М", "Anton M") }
      )
    }
    customs_certification = [ordered]@{
      label = "Таможенное оформление и сертификация"
      selection = "round_robin"
      topics = @(
        "расчёт таможенных платежей"
        "ввоз автомобилей"
        "импорт автомобилей"
        "растаможка автомобилей"
        "таможенное оформление автомобилей"
        "оформление автомобилей на таможне"
        "все вопросы по автомобилям"
        "таможенное оформление автомобилей и мототехники"
        "консультации по таможенному оформлению"
        "сертификация продукции"
        "разрешительные документы"
      )
      destinations = @(
        [ordered]@{ extension = "145"; employee = "Natal'ya E."; aliases = @("Наталья Е", "Natalya E", "Natal'ya E") }
        [ordered]@{ extension = "147"; employee = "Natalia B."; aliases = @("Наталия Б", "Наталья Б", "Natalia B") }
      )
    }
    accounting = [ordered]@{
      label = "Бухгалтерия"
      selection = "round_robin"
      topics = @(
        "бухгалтерские документы"
        "акты, счета и сверки"
        "вопросы бухгалтерии"
      )
      destinations = @(
        [ordered]@{ extension = "152"; employee = "Nastya"; aliases = @("Настя", "Анастасия", "Nastya") }
        [ordered]@{ extension = "153"; employee = "Nastya Z."; aliases = @("Настя З", "Анастасия З", "Nastya Z") }
      )
    }
    logistics = [ordered]@{
      label = "Логистика"
      selection = "round_robin"
      topics = @(
        "международные перевозки"
        "внутрироссийские перевозки"
        "морская, автомобильная, железнодорожная, авиационная и мультимодальная логистика"
        "перевозка грузов"
      )
      destinations = @(
        [ordered]@{ extension = "171"; employee = "Viktoria E."; aliases = @("Виктория", "Виктория Е", "Viktoria E") }
        [ordered]@{ extension = "173"; employee = "Sergey O."; aliases = @("Сергей", "Сергей О", "Sergey O") }
      )
    }
  }
  managerTransferTimeoutSeconds = 15
  managerTransferNoAnswerMessage = "Сотрудник сейчас не смог ответить. Возможно, он ненадолго отошёл от рабочего места. Пожалуйста, отправьте все детали и техническое описание запроса на sales собака nbr точка ru. Ответственный сотрудник свяжется с вами по этому номеру в ближайшее рабочее время."
  internalTransfer = [ordered]@{
    enabled = $true
    allowedExtensionPattern = "^1[0-9]{2}$"
    blockedExtensions = @($Username)
    timeoutSeconds = 15
    noAnswerMessage = "Сотрудник по этому внутреннему номеру сейчас не смог ответить. Пожалуйста, отправьте все детали и техническое описание запроса на sales собака nbr точка ru. Ответственный сотрудник свяжется с вами по этому номеру в ближайшее рабочее время."
  }
  status = if ($secretStored) { "profile_and_secret_saved" } else { "profile_saved_secret_missing" }
  configuredAt = (Get-Date).ToString("o")
  notes = @(
    "AgenticMail core currently supports Twilio and 46elks phone providers, not direct SIP registration.",
    "This SIP profile is for a local PBX/SIP sidecar that registers extension 199 and bridges media to OpenAI Realtime.",
    "Live answering and outbound calls are controlled by liveAnswerEnabled and liveOutboundEnabled."
  )
}

Write-Utf8NoBom -Path $ConfigPath -Text ($payload | ConvertTo-Json -Depth 8)

[pscustomobject]@{
  status = "ok"
  configPath = $ConfigPath
  server = $Server
  serverAlias = $ServerAlias
  port = $Port
  transport = $Transport
  username = $Username
  secretStored = [bool]$secretStored
  liveAnswerEnabled = [bool]$EnableLiveAnswer
  liveOutboundEnabled = [bool]$EnableOutboundCalls
  agenticmailDirectSipSupported = $false
  sipSidecarSupported = $true
} | ConvertTo-Json -Depth 4
