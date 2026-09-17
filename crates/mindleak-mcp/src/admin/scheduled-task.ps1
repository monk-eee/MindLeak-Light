$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Read-TaskState($task) {
    $xml = Export-ScheduledTask -TaskName $task.TaskName -TaskPath '\'
    $digest = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($xml))
    $info = $task | Get-ScheduledTaskInfo
    return @{
        present = $true
        enabled = [bool]$task.Settings.Enabled
        active = ([string]$task.State -in @('Ready', 'Running'))
        owner = $task.Description
        logonType = [string]$task.Principal.LogonType
        lastResult = $info.LastTaskResult
        lastRun = $info.LastRunTime.ToUniversalTime().ToString('o')
        nextRun = $info.NextRunTime.ToUniversalTime().ToString('o')
        definitionSha256 = [System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
    }
}

switch ($env:ML_JOB_ACTION) {
    'inspect' {
        $task = Get-ScheduledTask -TaskName $env:ML_JOB_NAME -TaskPath '\' -ErrorAction SilentlyContinue
        if ($null -eq $task) { $result = @{ present = $false } }
        else { $result = Read-TaskState $task }
    }
    'install' {
        if (Get-ScheduledTask -TaskName $env:ML_JOB_NAME -TaskPath '\' -ErrorAction SilentlyContinue) { exit 6 }
        if ((Get-TimeZone).Id -ne $env:ML_TIMEZONE) { exit 2 }
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Limited
        $action = New-ScheduledTaskAction -Execute $env:ML_BINARY -Argument $env:ML_ARGUMENTS
        if ($env:ML_WEEKLY -eq 'true') {
            $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $env:ML_TIME
        } else {
            $trigger = New-ScheduledTaskTrigger -Daily -At $env:ML_TIME
        }
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromSeconds([double]$env:ML_TIMEOUT))
        $settings.Enabled = $false
        $task = Register-ScheduledTask -TaskName $env:ML_JOB_NAME -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $env:ML_OWNER -ErrorAction Stop
        $result = Read-TaskState $task
    }
    'activate' {
        $task = Get-ScheduledTask -TaskName $env:ML_JOB_NAME -TaskPath '\'
        $state = Read-TaskState $task
        if ($task.Description -ne $env:ML_OWNER -or $state.definitionSha256 -ne $env:ML_DEFINITION_SHA256) { exit 6 }
        $task = Enable-ScheduledTask -InputObject $task
        $result = Read-TaskState $task
    }
    'remove' {
        $task = Get-ScheduledTask -TaskName $env:ML_JOB_NAME -TaskPath '\' -ErrorAction SilentlyContinue
        if ($null -eq $task) { $result = @{ removed = $false; absent = $true }; break }
        $state = Read-TaskState $task
        if ($task.Description -ne $env:ML_OWNER -or $state.definitionSha256 -ne $env:ML_DEFINITION_SHA256) { exit 6 }
        Unregister-ScheduledTask -InputObject $task -Confirm:$false
        $result = @{ removed = $true }
    }
    default { exit 2 }
}
$result | ConvertTo-Json -Depth 5 -Compress
