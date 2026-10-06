using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

class DpapiSearch
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

    public static byte[] TryDecrypt(byte[] encrypted)
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

            if (!success) return null;

            byte[] decrypted = new byte[dataOut.cbData];
            Marshal.Copy(dataOut.pbData, decrypted, 0, dataOut.cbData);
            return decrypted;
        }
        catch { return null; }
        finally
        {
            if (dataIn.pbData != IntPtr.Zero) Marshal.FreeHGlobal(dataIn.pbData);
            if (dataOut.pbData != IntPtr.Zero) Marshal.FreeHGlobal(dataOut.pbData);
        }
    }

    static bool IsPrintable(byte[] data)
    {
        int printable = 0;
        for (int i = 0; i < Math.Min(data.Length, 100); i++)
        {
            if (data[i] >= 0x20 && data[i] <= 0x7E) printable++;
        }
        return printable > Math.Min(data.Length, 100) * 0.7;
    }

    static void Main(string[] args)
    {
        string root = @"C:\Users\15366\.workbuddy";
        string[] files = Directory.GetFiles(root, "*.*", SearchOption.AllDirectories);
        int found = 0;

        foreach (string file in files)
        {
            try
            {
                FileInfo fi = new FileInfo(file);
                if (fi.Length > 500000 || fi.Length < 10) continue;
                byte[] data = File.ReadAllBytes(file);

                for (int i = 0; i < data.Length - 20; i++)
                {
                    if (data[i] == 0x01 && data[i+1] == 0x00 &&
                        data[i+2] == 0x00 && data[i+3] == 0x00)
                    {
                        for (int len = 50; len <= 500 && i + len <= data.Length; len += 1)
                        {
                            byte[] blob = new byte[len];
                            Array.Copy(data, i, blob, 0, len);
                            byte[] dec = TryDecrypt(blob);
                            if (dec != null && dec.Length > 5 && IsPrintable(dec))
                            {
                                string text = Encoding.UTF8.GetString(dec);
                                if (text.IndexOf("token", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                    text.IndexOf("auth", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                    text.IndexOf("key", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                    text.IndexOf("secret", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                    text.IndexOf("bearer", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                    text.IndexOf("access", StringComparison.OrdinalIgnoreCase) >= 0)
                                {
                                    Console.WriteLine("\n=== Found in: " + file + " offset=" + i + " len=" + len + " ===");
                                    Console.WriteLine("Decrypted (" + dec.Length + " bytes): " + text.Substring(0, Math.Min(300, text.Length)));
                                    found++;
                                }
                            }
                        }
                    }
                }
            }
            catch { }
        }

        Console.WriteLine("\nTotal found: " + found);
    }
}
