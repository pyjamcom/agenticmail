param(
  [string]$Email = "sales@nbr.ru"
)

$ErrorActionPreference = "Stop"

$searcher = New-Object System.DirectoryServices.DirectorySearcher
$escaped = $Email.Replace("\", "\5c").Replace("(", "\28").Replace(")", "\29")
$searcher.Filter = "(|(mail=$escaped)(proxyAddresses=smtp:$escaped)(proxyAddresses=SMTP:$escaped))"
@(
  "displayName",
  "mail",
  "proxyAddresses",
  "msExchRecipientTypeDetails",
  "msExchRecipientDisplayType",
  "homeMDB",
  "legacyExchangeDN",
  "objectClass",
  "distinguishedName",
  "sAMAccountName",
  "userPrincipalName"
) | ForEach-Object { [void]$searcher.PropertiesToLoad.Add($_) }

$results = $searcher.FindAll()
$out = foreach ($result in $results) {
  $p = $result.Properties
  [pscustomobject]@{
    DisplayName = ($p.displayname | Select-Object -First 1)
    Mail = ($p.mail | Select-Object -First 1)
    SamAccountName = ($p.samaccountname | Select-Object -First 1)
    UserPrincipalName = ($p.userprincipalname | Select-Object -First 1)
    ObjectClass = @($p.objectclass)
    RecipientTypeDetails = ($p.msexchrecipienttypedetails | Select-Object -First 1)
    RecipientDisplayType = ($p.msexchrecipientdisplaytype | Select-Object -First 1)
    HasMailboxDatabase = [bool]($p.homemdb | Select-Object -First 1)
    HasLegacyExchangeDn = [bool]($p.legacyexchangedn | Select-Object -First 1)
    MatchingProxy = @($p.proxyaddresses | Where-Object { $_ -match [regex]::Escape($Email) })
    DistinguishedName = ($p.distinguishedname | Select-Object -First 1)
  }
}

if ($out) {
  $out | ConvertTo-Json -Depth 5
} else {
  [pscustomobject]@{ ResultCount = 0; Email = $Email } | ConvertTo-Json
}
