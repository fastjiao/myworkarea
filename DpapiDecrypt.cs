using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class DpapiDecrypt
{
    [StructLayout(LayoutKind.Sequential)]
    public struct DATA_BLOB
    {
        public int cbData;
        public IntPtr pbData;
    }

    [DllImport("crypt32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool CryptUnprotectData(
        ref DATA_BLOB pDataIn,
        StringBuilder ppszDataDescr,
        ref DATA_BLOB pOptionalEntropy,
        IntPtr pvReserved,
        ref DATA_BLOB pPromptStruct,
        int dwFlags,
        ref DATA_BLOB pDataOut);

    public static byte[] Decrypt(byte[] encrypted)
    {
        DATA_BLOB dataIn = new DATA_BLOB();
        DATA_BLOB dataOut = new DATA_BLOB();
        DATA_BLOB optionalEntropy = new DATA_BLOB();
        DATA_BLOB promptStruct = new DATA_BLOB();

        try
        {
            dataIn.cbData = encrypted.Length;
            dataIn.pbData = Marshal.AllocHGlobal(encrypted.Length);
            Marshal.Copy(encrypted, 0, dataIn.pbData, encrypted.Length);

            bool success = CryptUnprotectData(
                ref dataIn,
                null,
                ref optionalEntropy,
                IntPtr.Zero,
                ref promptStruct,
                0,
                ref dataOut);

            if (!success)
            {
                throw new Exception("CryptUnprotectData failed: " + Marshal.GetLastWin32Error());
            }

            byte[] decrypted = new byte[dataOut.cbData];
            Marshal.Copy(dataOut.pbData, decrypted, 0, dataOut.cbData);
            return decrypted;
        }
        finally
        {
            if (dataIn.pbData != IntPtr.Zero) Marshal.FreeHGlobal(dataIn.pbData);
            if (dataOut.pbData != IntPtr.Zero) Marshal.FreeHGlobal(dataOut.pbData);
        }
    }

    static string ExtractJsonField(string json, string field)
    {
        string needle = "\"" + field + "\":\"";
        int start = json.IndexOf(needle);
        if (start < 0) return null;
        start += needle.Length;
        int end = json.IndexOf("\"", start);
        if (end < 0) return null;
        return json.Substring(start, end - start);
    }

    static void Main(string[] args)
    {
        string localStatePath = @"C:\Users\15366\.workbuddy\app\session\Local State";
        string json = File.ReadAllText(localStatePath);

        string encryptedKeyB64 = ExtractJsonField(json, "encrypted_key");
        Console.WriteLine("encrypted_key (b64): " + encryptedKeyB64.Substring(0, 50) + "...");

        byte[] encryptedKey = Convert.FromBase64String(encryptedKeyB64);
        Console.WriteLine("encrypted_key length: " + encryptedKey.Length);

        if (encryptedKey[0] == 0x44 && encryptedKey[1] == 0x50 &&
            encryptedKey[2] == 0x41 && encryptedKey[3] == 0x50 &&
            encryptedKey[4] == 0x49)
        {
            Console.WriteLine("Found DPAPI prefix, stripping 5 bytes...");
            byte[] dpapiBlob = new byte[encryptedKey.Length - 5];
            Array.Copy(encryptedKey, 5, dpapiBlob, 0, dpapiBlob.Length);

            byte[] decryptedKey = Decrypt(dpapiBlob);
            Console.WriteLine("Decrypted key length: " + decryptedKey.Length);
            Console.WriteLine("Decrypted key (hex): " + BitConverter.ToString(decryptedKey).Replace("-", ""));
            Console.WriteLine("Decrypted key (b64): " + Convert.ToBase64String(decryptedKey));

            File.WriteAllText(@"D:\tmp\os_crypt_key.txt", Convert.ToBase64String(decryptedKey));
            Console.WriteLine("Saved to D:\\tmp\\os_crypt_key.txt");
        }
        else
        {
            Console.WriteLine("No DPAPI prefix found, trying direct decrypt...");
            byte[] decryptedKey = Decrypt(encryptedKey);
            Console.WriteLine("Decrypted key length: " + decryptedKey.Length);
            Console.WriteLine("Decrypted key (hex): " + BitConverter.ToString(decryptedKey).Replace("-", ""));
        }
    }
}
