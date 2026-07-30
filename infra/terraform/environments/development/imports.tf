# Adopt the default route and eight live associations created by the manual
# development NAT-instance cutover. Keeping these import blocks documents the
# state transition and makes the first CI/CD plan reconcile state without
# attempting a conflicting EC2 AssociateRouteTable call.

import {
  to = aws_route.development_nat_default
  id = "rtb-0d877aa0f73f6ee09_0.0.0.0/0"
}

import {
  to = aws_route_table_association.control["ap-southeast-2a"]
  id = "rtbassoc-0e68e1d5921d08756"
}

import {
  to = aws_route_table_association.control["ap-southeast-2b"]
  id = "rtbassoc-0e460304dc4a0f705"
}

import {
  to = aws_route_table_association.agent["ap-southeast-2a"]
  id = "rtbassoc-0b67b141fa9e85a46"
}

import {
  to = aws_route_table_association.agent["ap-southeast-2b"]
  id = "rtbassoc-07455be0fde7a6897"
}

import {
  to = aws_route_table_association.source_fetcher["ap-southeast-2a"]
  id = "rtbassoc-07b775117a7943b18"
}

import {
  to = aws_route_table_association.source_fetcher["ap-southeast-2b"]
  id = "rtbassoc-09794ca184fcfe227"
}

import {
  to = aws_route_table_association.verifier["ap-southeast-2a"]
  id = "rtbassoc-0b86a3a74f897922b"
}

import {
  to = aws_route_table_association.verifier["ap-southeast-2b"]
  id = "rtbassoc-002cc2df237bdf382"
}
